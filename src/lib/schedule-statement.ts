// Schedule-based client statement model (single source of truth).
//
// A STATEMENT OF ACCOUNT lists money movements (ledger order); a SCHEDULE
// STATEMENT lists the payment plan itself, one row per installment, with what
// was scheduled, what has been received against it, and where it stands. Both
// derive from the SAME replay (allocations.ts) — this module never queries the
// DB and never trusts a stored total, so it can never disagree with the
// payment schedule, receipts or the finance service.
//
// Wording is deliberately client-facing: no staff-only warnings, no "assumed"
// notes, no internal queues. Money is whole-naira Int, never floats.

import { orderConfirmedPayments, type AllocationInstallment, type AllocationPayment } from "@/lib/finance/allocations";
import { formatDateDMY } from "@/lib/time";
import { formatNaira } from "@/lib/currency";

export const SCHEDULE_LAYOUT_VERSION = "sched-v1";

export type ScheduleStatementRow = {
  dueDate: string; // dd-mm-yyyy
  label: string; // "Initial deposit" / "Month 3 payment"
  scheduled: number;
  received: number;
  status: string; // client wording, e.g. "Part paid, ₦656,250 remaining"
  settled: boolean;
};

export type ScheduleStatementTotals = {
  scheduled: number;
  received: number;
  outstanding: number; // contract total - received; negative means credit
  credit: number; // max(0, received - contract total)
};

export type ScheduleStatement = {
  rows: ScheduleStatementRow[];
  totals: ScheduleStatementTotals;
  nextDue: { dueDate: string; label: string; amount: number } | null;
  fullyPaid: boolean;
  settledOn: string | null; // dd-mm-yyyy the plan was completed, when fully paid
  layoutVersion: string;
};

export type ScheduleStatementInput = {
  installments: AllocationInstallment[];
  payments: AllocationPayment[];
  now: Date;
  // The contract balance the plan is measured against. Optional so the pure
  // builder still works from a schedule alone; when absent the schedule's own
  // sum stands in. The DB-backed model always passes it.
  totalPayable?: number;
  formatDate?: (d: Date | string) => string;
  formatMoney?: (n: number) => string;
};

const defaultDate = (d: Date | string): string => formatDateDMY(d);
const defaultMoney = (n: number): string => formatNaira(n);

// Client-facing installment label. Matches appliedToLabel's vocabulary
// (Initial deposit / Month N) so the schedule and the receipts read alike.
export function scheduleRowLabel(type: string, installmentNumber: number): string {
  if (type === "INITIAL") return "Initial deposit";
  return `Month ${installmentNumber} payment`;
}

// The date each installment reached its scheduled amount, walking the same
// waterfall order (confirmed payments by date, then id). Returns the date of
// the payment that completed the installment, or null while it is open.
function settlementDates(
  installments: AllocationInstallment[],
  payments: AllocationPayment[]
): Map<string, Date> {
  const ordered = [...installments].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const filled = new Map<string, number>(ordered.map((i) => [i.id, 0]));
  const settledAt = new Map<string, Date>();
  for (const p of orderConfirmedPayments(payments)) {
    let remaining = p.amount;
    for (const inst of ordered) {
      if (remaining <= 0) break;
      const already = filled.get(inst.id) ?? 0;
      const capacity = inst.scheduledAmount - already;
      if (capacity <= 0) continue;
      const take = Math.min(remaining, capacity);
      filled.set(inst.id, already + take);
      remaining -= take;
      if (already + take >= inst.scheduledAmount && !settledAt.has(inst.id)) {
        settledAt.set(inst.id, new Date(p.paymentDate));
      }
    }
  }
  return settledAt;
}

export function buildScheduleStatement(input: ScheduleStatementInput): ScheduleStatement {
  const fmtDate = input.formatDate ?? defaultDate;
  const fmtMoney = input.formatMoney ?? defaultMoney;
  const ordered = [...input.installments].sort((a, b) => a.installmentNumber - b.installmentNumber);

  // Received per installment comes from the shared replay (capped at the
  // scheduled amount; anything beyond the whole plan is credit).
  const receivedById = new Map<string, number>();
  for (const inst of ordered) receivedById.set(inst.id, 0);
  {
    // Inline waterfall so the cap and the settlement dates come from one pass
    // of the same rule; orderConfirmedPayments keeps it deterministic.
    const filled = new Map<string, number>(ordered.map((i) => [i.id, 0]));
    for (const p of orderConfirmedPayments(input.payments)) {
      let remaining = p.amount;
      for (const inst of ordered) {
        if (remaining <= 0) break;
        const already = filled.get(inst.id) ?? 0;
        const capacity = inst.scheduledAmount - already;
        if (capacity <= 0) continue;
        const take = Math.min(remaining, capacity);
        filled.set(inst.id, already + take);
        remaining -= take;
      }
    }
    for (const inst of ordered) receivedById.set(inst.id, filled.get(inst.id) ?? 0);
  }
  const settledAt = settlementDates(ordered, input.payments);

  // Confirmed money actually received, uncapped, and the contract balance it
  // is measured against. The balance decides completion; the schedule only
  // describes it.
  const receivedTotal = orderConfirmedPayments(input.payments).reduce((sum, p) => sum + p.amount, 0);
  const scheduledTotal = ordered.reduce((sum, i) => sum + i.scheduledAmount, 0);
  const contractTotal = input.totalPayable ?? scheduledTotal;
  const contractSettled = receivedTotal >= contractTotal;

  const rows: ScheduleStatementRow[] = [];
  for (const inst of ordered) {
    const received = receivedById.get(inst.id) ?? 0;
    const remaining = Math.max(0, inst.scheduledAmount - received);
    const settled = received >= inst.scheduledAmount;
    const settledOnDate = settledAt.get(inst.id);
    let status: string;
    if (settled) {
      status =
        settledOnDate && new Date(settledOnDate) < new Date(inst.dueDate)
          ? `Paid early, ${fmtDate(settledOnDate)}`
          : "Paid";
    } else if (contractSettled) {
      // Nothing is owed: this row is short only because the plan asks for more
      // than the contract. A paid-up client must never read "Overdue".
      status = "Paid";
    } else if (received > 0) {
      status = `Part paid, ${fmtMoney(remaining)} remaining`;
    } else if (new Date(inst.dueDate) < input.now) {
      status = `Overdue, ${fmtMoney(remaining)} remaining`;
    } else {
      status = `Not yet due, ${fmtMoney(remaining)} remaining`;
    }
    rows.push({
      dueDate: fmtDate(inst.dueDate),
      label: scheduleRowLabel(inst.type, inst.installmentNumber),
      scheduled: inst.scheduledAmount,
      received,
      status,
      settled,
    });
  }

  const outstanding = contractTotal - receivedTotal;
  const nextOpen = rows.find((r) => !r.settled) ?? null;
  const openInstallment = nextOpen ? ordered[rows.indexOf(nextOpen)] : null;

  // The plan is complete when the contract balance is covered (credit, if
  // any, is money beyond the contract and leaves nothing open).
  const fullyPaid = rows.length > 0 && contractSettled;
  let settledOn: string | null = null;
  if (fullyPaid) {
    const dates = ordered.map((i) => settledAt.get(i.id)).filter((d): d is Date => !!d);
    if (dates.length > 0) {
      const last = new Date(Math.max(...dates.map((d) => d.getTime())));
      settledOn = fmtDate(last);
    } else {
      // Contract covered before any single row filled: date it from the money.
      const confirmed = orderConfirmedPayments(input.payments);
      const last = confirmed[confirmed.length - 1];
      if (last) settledOn = fmtDate(last.paymentDate);
    }
  }

  const nextAmount = nextOpen ? Math.max(0, nextOpen.scheduled - nextOpen.received) : 0;

  return {
    rows,
    totals: {
      scheduled: scheduledTotal,
      received: receivedTotal,
      outstanding,
      credit: Math.max(0, -outstanding),
    },
    nextDue: !contractSettled && nextOpen && openInstallment && nextAmount > 0
      ? { dueDate: fmtDate(openInstallment.dueDate), label: nextOpen.label, amount: nextAmount }
      : null,
    fullyPaid,
    settledOn,
    layoutVersion: SCHEDULE_LAYOUT_VERSION,
  };
}
