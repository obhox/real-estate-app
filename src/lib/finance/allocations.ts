// Allocation engine (single source of truth for per-installment money).
//
// A payment is NEVER tied to one installment. Confirmed payments are replayed
// in date order through one waterfall — earliest open installment first, each
// filled to its scheduled capacity, excess rolling forward — and the per-
// installment paid/remaining/status derives from that replay. This is the ONE
// rule every surface reads: the payment schedule, next-due, overdue queues,
// list overviews, receipts and statements. `Payment.installmentId` is a
// pointer for display only and never drives a money figure.
//
// Stored columns (Installment.paidAmount/status, PaymentAllocation rows) are
// written to match this replay so they agree; reads derive, they do not trust
// a stored total. Money is whole-naira Int, never floats.

import { lagosDayKey } from "@/lib/time";

export type FinanceInstallmentStatus = "Paid" | "Late" | "Partial" | "Pending" | "Settled";

// Display status from confirmed money only. Pending (unverified) payments
// never move an installment off Pending/Late.
//
// The contract balance outranks the row: once the transaction is settled, a
// row left short only because the plan asks for more than the contract is
// "Settled", never "Late" — a paid-up customer must never read as behind.
// The due-date test is a Lagos calendar-day compare, the same rule
// getTransactionFinancials uses, so the row and the balance cannot disagree
// on a day boundary.
export function toDisplayStatus(
  confirmedPaid: number,
  scheduledAmount: number,
  dueDate: Date,
  now: Date = new Date(),
  opts: { contractSettled?: boolean } = {}
): FinanceInstallmentStatus {
  if (confirmedPaid >= scheduledAmount) return "Paid";
  if (opts.contractSettled) return "Settled";
  if (lagosDayKey(dueDate) < lagosDayKey(now)) return "Late";
  if (confirmedPaid > 0) return "Partial";
  return "Pending";
}

export type AllocationInstallment = {
  id: string;
  installmentNumber: number;
  type: string;
  dueDate: Date;
  scheduledAmount: number;
};

export type AllocationPayment = {
  id: string;
  amount: number;
  paymentDate: Date;
  // Absent means "already known to be confirmed" (e.g. a pre-filtered list).
  status?: string;
};

export type InstallmentAllocation = AllocationInstallment & {
  confirmedPaid: number;
};

// Confirmed payments in the order the waterfall replays them: effective
// payment date, ties broken by id so the result is deterministic.
export function orderConfirmedPayments(payments: AllocationPayment[]): AllocationPayment[] {
  return payments
    .filter((p) => (p.status === undefined || p.status === "CONFIRMED") && p.amount > 0)
    .sort((a, b) => {
      const ta = new Date(a.paymentDate).getTime();
      const tb = new Date(b.paymentDate).getTime();
      return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
}

// Attribution of ONE confirmed payment through the waterfall: which
// installments it filled (in order) and how much of it stayed as credit.
export type PaymentAllocationResult = {
  paymentId: string;
  allocations: { installmentId: string; amount: number }[];
  credit: number;
};

export type AllocationDetail = {
  installments: InstallmentAllocation[];
  credit: number;
  payments: PaymentAllocationResult[];
};

// Waterfall replay, with per-payment attribution. This is the single rule:
// confirmed payments in date order are poured into the schedule earliest-open
// first, each filled to capacity, excess rolling forward; whatever survives
// every installment is credit. sum(confirmedPaid) + credit === sum(amounts),
// and each payment's allocations + its credit === its amount.
export function replayAllocationDetail(
  installments: AllocationInstallment[],
  payments: AllocationPayment[]
): AllocationDetail {
  const ordered = [...installments].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const allocated = new Map<string, number>(ordered.map((i) => [i.id, 0]));
  const results: PaymentAllocationResult[] = [];
  let credit = 0;
  for (const p of orderConfirmedPayments(payments)) {
    let remaining = p.amount;
    const parts: { installmentId: string; amount: number }[] = [];
    for (const inst of ordered) {
      if (remaining <= 0) break;
      const already = allocated.get(inst.id) ?? 0;
      const capacity = inst.scheduledAmount - already;
      if (capacity <= 0) continue;
      const take = Math.min(remaining, capacity);
      allocated.set(inst.id, already + take);
      parts.push({ installmentId: inst.id, amount: take });
      remaining -= take;
    }
    credit += remaining;
    results.push({ paymentId: p.id, allocations: parts, credit: remaining });
  }
  return {
    installments: ordered.map((inst) => ({ ...inst, confirmedPaid: allocated.get(inst.id) ?? 0 })),
    credit,
    payments: results,
  };
}

// Waterfall replay. Returns each installment's confirmed-paid (never above
// its scheduled amount) plus the credit — money left over once every
// installment is full. sum(confirmedPaid) + credit === sum(confirmed amounts).
export function replayAllocation(
  installments: AllocationInstallment[],
  payments: AllocationPayment[]
): { installments: InstallmentAllocation[]; credit: number } {
  const { installments: rows, credit } = replayAllocationDetail(installments, payments);
  return { installments: rows, credit };
}

export type InstallmentView = InstallmentAllocation & {
  pendingTotal: number;
  status: FinanceInstallmentStatus;
  overdue: boolean;
};

// Per-installment display view. pendingByInstallment is a display-only hint
// (pending payments still carry their own installmentId pointer) and is never
// counted as paid.
export function deriveInstallmentViews(
  installments: AllocationInstallment[],
  payments: AllocationPayment[],
  now: Date,
  pendingByInstallment: Map<string, number> = new Map(),
  opts: { contractSettled?: boolean } = {}
): { views: InstallmentView[]; credit: number } {
  const { installments: allocated, credit } = replayAllocation(installments, payments);
  const views = allocated.map((a) => {
    const status = toDisplayStatus(a.confirmedPaid, a.scheduledAmount, a.dueDate, now, opts);
    return {
      ...a,
      pendingTotal: pendingByInstallment.get(a.id) ?? 0,
      status,
      overdue: status === "Late",
    };
  });
  return { views, credit };
}
