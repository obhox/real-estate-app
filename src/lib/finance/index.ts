import { prisma } from "@/lib/prisma";
import { deriveInstallmentStatus } from "@/lib/paymentConfirmation";
import { lagosDayKey, startOfTodayLagos } from "@/lib/time";
import {
  deriveInstallmentViews,
  replayAllocation,
  toDisplayStatus,
  type AllocationInstallment,
  type FinanceInstallmentStatus,
  type InstallmentView,
} from "./allocations";

export { toDisplayStatus };
export type { FinanceInstallmentStatus, InstallmentView };

// Single source of truth for every financial figure in the app
// (AGENTS.md rule 3). Pages and API routes must call these functions —
// never their own ad-hoc money queries — so dashboard, ledger and
// transaction pages always agree.
//
// Definitions:
// - "Collected" = CONFIRMED payments only, by paymentDate. Pending, failed
//   and voided (CANCELLED) payments never count. (No VOIDED status exists;
//   voiding sets CANCELLED.)
// - Test fixtures (transaction.isTest) are excluded everywhere.
// - Installment display status derives from confirmed money:
//   Paid (>= scheduled) → Late (past due, not fully paid) → Partial
//   (0 < paid < scheduled) → Pending.

export type TransactionSummary = {
  id: string;
  ref: string;
  totalPayable: number;
  confirmedPaid: number;
  outstanding: number;
  progressPct: number;
  overdueCount: number;
  overdueAmount: number;
  nextInstallment: NextInstallmentDue | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
  daysOverdue: number | null;
  isFullyPaid: boolean;
  isOverpaid: boolean;
  overpaidAmount: number;
  installments: InstallmentView[];
};

// Minimal DB surface so tests can inject fakes.
export type FinanceDb = {
  payment: {
    aggregate(args: unknown): Promise<{ _sum: { amount: number | null } }>;
    count(args: unknown): Promise<number>;
    findMany(args: unknown): Promise<
      { id: string; amount: number; paymentDate: Date; status: string; installmentId: string | null; transactionId: string }[]
    >;
  };
  installment: {
    findMany(args: unknown): Promise<
      { id: string; transactionId: string; installmentNumber: number; type: string; dueDate: Date; scheduledAmount: number; status: string }[]
    >;
  };
  transaction: {
    findMany(args: unknown): Promise<{ id: string; totalPayable: number }[]>;
    findUnique(args: unknown): Promise<
      | {
          id: string;
          ref: string;
          totalPayable: number;
          isTest: boolean;
          installments: { id: string; installmentNumber: number; type: string; dueDate: Date; scheduledAmount: number; status: string }[];
        }
      | null
    >;
  };
};

const realDb = prisma as unknown as FinanceDb;

function confirmedWhere(from?: Date, to?: Date, includeTest: boolean = false) {
  return {
    status: "CONFIRMED" as const,
    ...(includeTest ? {} : { transaction: { isTest: false } }),
    ...(from || to ? { paymentDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };
}

export async function getCollectedRevenue(
  { from, to, includeTest = false }: { from?: Date; to?: Date; includeTest?: boolean } = {},
  db: FinanceDb = realDb
): Promise<number> {
  const agg = await db.payment.aggregate({ where: confirmedWhere(from, to, includeTest), _sum: { amount: true } });
  return agg._sum.amount ?? 0;
}

export async function getOverdueInstallments(
  db: FinanceDb = realDb,
  now: Date = startOfTodayLagos(),
  opts: { includeTest?: boolean } = {}
) {
  const rows = await db.installment.findMany({
    where: {
      ...(opts.includeTest ? {} : { transaction: { isTest: false } }),
      dueDate: { lt: now },
      status: { notIn: ["WAIVED"] },
    },
    orderBy: { dueDate: "asc" },
  });
  if (rows.length === 0) return [];
  const txnIds = [...new Set(rows.map((r) => r.transactionId))];
  const testFilter = opts.includeTest ? {} : { transaction: { isTest: false } };
  const txnTestFilter = opts.includeTest ? {} : { isTest: false };
  // Every installment of the candidate transactions (not just the past-due
  // ones) and the confirmed money, so the overdue verdict is the same
  // balance-first one getTransactionFinancials gives every other surface.
  const [allInst, payments, txns] = await Promise.all([
    db.installment.findMany({
      where: { transactionId: { in: txnIds }, status: { notIn: ["WAIVED"] }, ...testFilter },
    }),
    db.payment.findMany({
      where: { status: "CONFIRMED", transactionId: { in: txnIds } },
      select: { id: true, amount: true, paymentDate: true, status: true, installmentId: true, transactionId: true },
    }),
    db.transaction.findMany({ where: { id: { in: txnIds }, ...txnTestFilter }, select: { id: true, totalPayable: true } }),
  ]);
  const totalByTxn = new Map(txns.map((t) => [t.id, t.totalPayable]));
  const instByTxn = new Map<string, AllocationInstallment[]>();
  for (const r of allInst) {
    const list = instByTxn.get(r.transactionId) ?? [];
    list.push({ id: r.id, installmentNumber: r.installmentNumber, type: r.type, dueDate: new Date(r.dueDate), scheduledAmount: r.scheduledAmount });
    instByTxn.set(r.transactionId, list);
  }
  // Per-installment paid is the waterfall replay of the transaction's
  // confirmed payments; a transaction only contributes overdue rows when its
  // balance-first overdueAmount is positive, so a settled transaction whose
  // schedule happens to leave a past-due row short can never show as overdue.
  const paidByInst = new Map<string, number>();
  const overdueTxn = new Set<string>();
  for (const txnId of txnIds) {
    const insts = instByTxn.get(txnId) ?? [];
    const { installments: allocated, credit } = replayAllocation(
      insts,
      payments.filter((p) => p.transactionId === txnId)
    );
    for (const a of allocated) paidByInst.set(a.id, a.confirmedPaid);
    // A missing totalPayable row should not happen; fall back to the schedule
    // sum (previous behaviour) rather than hide overdue money.
    const totalPayable = totalByTxn.get(txnId) ?? allocated.reduce((s, a) => s + a.scheduledAmount, 0);
    const fin = getTransactionFinancials(
      {
        totalPayable,
        unlinkedConfirmed: credit,
        installments: allocated.map((a) => ({
          installmentNumber: a.installmentNumber,
          type: a.type,
          dueDate: a.dueDate,
          scheduledAmount: a.scheduledAmount,
          confirmedPaid: a.confirmedPaid,
        })),
      },
      now
    );
    if (fin.overdueAmount > 0) overdueTxn.add(txnId);
  }
  return rows
    .filter((r) => overdueTxn.has(r.transactionId))
    .map((r) => ({ ...r, confirmedPaid: paidByInst.get(r.id) ?? 0 }))
    .filter((r) => r.confirmedPaid < r.scheduledAmount);
}

export async function getTransactionSummary(
  transactionId: string,
  db: FinanceDb = realDb,
  now: Date = startOfTodayLagos(),
  opts: { includeTest?: boolean } = {}
): Promise<TransactionSummary | null> {
  const txn = await db.transaction.findUnique({
    where: { id: transactionId },
    include: { installments: { orderBy: { installmentNumber: "asc" } } },
  });
  if (!txn) return null;
  if (txn.isTest && !opts.includeTest) return null;
  const payments = await db.payment.findMany({
    where: { transactionId, status: { in: ["CONFIRMED", "PENDING_VERIFICATION"] } },
    select: { id: true, amount: true, status: true, installmentId: true, paymentDate: true },
  });
  const pendingByInst = new Map<string, number>();
  let confirmedPaid = 0;
  for (const p of payments) {
    if (p.status === "CONFIRMED") confirmedPaid += p.amount;
    else if (p.installmentId) pendingByInst.set(p.installmentId, (pendingByInst.get(p.installmentId) ?? 0) + p.amount);
  }
  // Balance-first, the same rule getTransactionFinancials applies: once the
  // contract is covered no row may read Late, whatever the schedule says.
  const contractSettled = confirmedPaid >= txn.totalPayable;
  // Per-installment paid is the waterfall replay of this transaction's
  // confirmed payments — the same rule the schedule, next-due, overdue lists,
  // receipts and statements read. The Payment.installmentId pointer never
  // moves a money figure; it only hints which row shows a pending payment.
  const { views, credit } = deriveInstallmentViews(
    txn.installments
      // Waived installments are not owed: drop them so the schedule, next-due
      // and overdue agree with getTransactionOverviews (which filters WAIVED).
      .filter((i) => i.status !== "WAIVED")
      .map((i) => ({
        id: i.id,
        installmentNumber: i.installmentNumber,
        type: i.type,
        dueDate: new Date(i.dueDate),
        scheduledAmount: i.scheduledAmount,
      })),
    payments.map((p) => ({ id: p.id, amount: p.amount, paymentDate: new Date(p.paymentDate), status: p.status })),
    now,
    pendingByInst,
    { contractSettled }
  );
  const installments = views;
  // Totals, next-due and overdue derive from the shared helper so every
  // surface agrees. Every confirmed naira is allocated or held as credit, so
  // totalPaid stays exactly the sum of confirmed payments.
  const fin = getTransactionFinancials(
    {
      totalPayable: txn.totalPayable,
      unlinkedConfirmed: credit,
      installments: installments.map((i) => ({
        installmentNumber: i.installmentNumber,
        type: i.type,
        dueDate: i.dueDate,
        scheduledAmount: i.scheduledAmount,
        confirmedPaid: i.confirmedPaid,
      })),
    },
    now
  );
  return {
    id: txn.id,
    ref: txn.ref,
    totalPayable: txn.totalPayable,
    confirmedPaid,
    outstanding: fin.outstanding,
    progressPct: fin.progressPct,
    overdueCount: fin.overdueCount,
    overdueAmount: fin.overdueAmount,
    nextInstallment: fin.nextInstallment,
    isOverdue: fin.isOverdue,
    daysUntilDue: fin.daysUntilDue,
    daysOverdue: fin.daysOverdue,
    isFullyPaid: fin.isFullyPaid,
    isOverpaid: fin.isOverpaid,
    overpaidAmount: fin.overpaidAmount,
    installments,
  };
}

// Re-exported for call sites that still need the stored-label derivation.
export { deriveInstallmentStatus };

// ---------------------------------------------------------------------------
// getTransactionFinancials: the ONE shared money helper (Phase 2A). Every
// screen — list, detail, ledger — derives totalPaid / outstanding / next-due
// / overdue from here, never from its own query. Receipts render per-payment
// snapshots and intentionally stay outside this helper.
//
// Input is confirmed money per installment (see getTransactionSummary /
// getTransactionOverviews below); excess paid on one installment rolls
// forward as cover for the next (carry-forward), mirroring the waterfall
// allocation applied at payment confirmation.
// ---------------------------------------------------------------------------

export type FinancialInstallmentInput = {
  installmentNumber: number;
  type: string;
  dueDate: Date;
  scheduledAmount: number;
  confirmedPaid: number;
};

export type NextInstallmentDue = {
  number: number;
  type: string;
  amountDue: number;
  dueDate: Date;
};

export type TransactionFinancials = {
  totalPayable: number;
  totalPaid: number;
  // totalPayable - totalPaid. Negative only when overpaid.
  outstanding: number;
  progressPct: number;
  nextInstallment: NextInstallmentDue | null;
  overdueCount: number;
  // Overdue money: scheduled naira past its due date that confirmed payments
  // have not covered. Zero whenever the balance is settled, by construction.
  overdueAmount: number;
  isOverdue: boolean;
  // Calendar-day distance (Lagos) from today to the next due date.
  // Exactly one is non-null when a next installment exists.
  daysUntilDue: number | null;
  daysOverdue: number | null;
  isFullyPaid: boolean;
  isOverpaid: boolean;
  overpaidAmount: number;
  // Balance still owed but no scheduled installment left to cover it — a
  // schedule/contract mismatch worth surfacing to ops (never rendered red).
  scheduleDeficit: boolean;
};

function dayKeyDiff(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

export function getTransactionFinancials(
  txn: { totalPayable: number; installments: FinancialInstallmentInput[]; unlinkedConfirmed?: number },
  now: Date = startOfTodayLagos()
): TransactionFinancials {
  const ordered = [...txn.installments].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const totalPaid = ordered.reduce((s, i) => s + i.confirmedPaid, 0) + (txn.unlinkedConfirmed ?? 0);
  const outstanding = txn.totalPayable - totalPaid;
  const todayKey = lagosDayKey(now);
  const progressPct = txn.totalPayable > 0 ? Math.round((totalPaid / txn.totalPayable) * 10000) / 100 : 0;
  const isOverpaid = outstanding < 0;
  const overpaidAmount = isOverpaid ? -outstanding : 0;

  // Balance-first: once the balance is settled the transaction is Paid in
  // full — no next due, no overdue, never red — no matter what the schedule
  // rows say. This is what makes a schedule whose rows don't sum to the
  // contract (deficit or surplus) structurally unable to read "Behind".
  if (outstanding <= 0) {
    return {
      totalPayable: txn.totalPayable,
      totalPaid,
      outstanding,
      progressPct,
      nextInstallment: null,
      overdueCount: 0,
      overdueAmount: 0,
      isOverdue: false,
      daysUntilDue: null,
      daysOverdue: null,
      isFullyPaid: true,
      isOverpaid,
      overpaidAmount,
      scheduleDeficit: false,
    };
  }

  // Money is still owed. Walk the schedule in order, rolling unlinked
  // confirmed money and any excess on one installment forward as cover for the
  // next (the same carry-forward the confirmation waterfall applies).
  let carry = txn.unlinkedConfirmed ?? 0;
  let scheduledTotal = 0;
  let nextInstallment: NextInstallmentDue | null = null;
  let overdueCount = 0;
  let overdueAmount = 0;
  for (const i of ordered) {
    scheduledTotal += i.scheduledAmount;
    const due = Math.max(0, i.scheduledAmount - i.confirmedPaid - carry);
    carry = Math.max(0, i.confirmedPaid + carry - i.scheduledAmount);
    if (due <= 0) continue;
    if (!nextInstallment) {
      nextInstallment = { number: i.installmentNumber, type: i.type, amountDue: due, dueDate: new Date(i.dueDate) };
    }
    if (lagosDayKey(i.dueDate) < todayKey) {
      overdueCount += 1;
      overdueAmount += due;
    }
  }

  let daysUntilDue: number | null = null;
  let daysOverdue: number | null = null;
  if (nextInstallment) {
    const diff = dayKeyDiff(todayKey, lagosDayKey(nextInstallment.dueDate));
    if (diff < 0) daysOverdue = -diff;
    else daysUntilDue = diff;
  }
  return {
    totalPayable: txn.totalPayable,
    totalPaid,
    outstanding,
    progressPct,
    nextInstallment,
    overdueCount,
    overdueAmount,
    // Overdue is driven by money past due, not by any stored label.
    isOverdue: overdueAmount > 0,
    daysUntilDue,
    daysOverdue,
    isFullyPaid: false,
    isOverpaid,
    overpaidAmount,
    scheduleDeficit: scheduledTotal < txn.totalPayable,
  };
}

// Awaiting verification: count + naira total of PENDING_VERIFICATION payments
// on real transactions. Never counted as collected.
export async function getPendingVerification(
  db: FinanceDb = realDb,
  opts: { includeTest?: boolean } = {}
): Promise<{ count: number; total: number }> {
  const where = {
    status: "PENDING_VERIFICATION" as const,
    ...(opts.includeTest ? {} : { transaction: { isTest: false } }),
  };
  const [agg, count] = await Promise.all([
    db.payment.aggregate({ where, _sum: { amount: true } }),
    db.payment.count({ where }),
  ]);
  return { count, total: agg._sum.amount ?? 0 };
}

export type TransactionOverview = {
  id: string;
  confirmedPaid: number;
  outstanding: number;
  overdueCount: number;
  overdueAmount: number;
  nextInstallment: NextInstallmentDue | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
  daysOverdue: number | null;
  isFullyPaid: boolean;
  isOverpaid: boolean;
  overpaidAmount: number;
  scheduleDeficit: boolean;
};

// Batch per-transaction money for list views (one query set, no N+1, no
// ad-hoc sums in pages). totalPayable is a contract term read from the row;
// outstanding/overdue always derive from CONFIRMED payments here.
export async function getTransactionOverviews(
  transactionIds: string[],
  db: FinanceDb = realDb,
  now: Date = startOfTodayLagos()
): Promise<Map<string, TransactionOverview>> {
  const out = new Map<string, TransactionOverview>();
  if (transactionIds.length === 0) return out;
  const [txns, installments, payments] = await Promise.all([
    db.transaction.findMany({ where: { id: { in: transactionIds } }, select: { id: true, totalPayable: true } }),
    db.installment.findMany({ where: { transactionId: { in: transactionIds } } }),
    db.payment.findMany({ where: { transactionId: { in: transactionIds }, status: "CONFIRMED" } }),
  ]);
  const instByTxn = new Map<string, AllocationInstallment[]>();
  for (const i of installments) {
    if (i.status === "WAIVED") continue;
    const list = instByTxn.get(i.transactionId) ?? [];
    list.push({
      id: i.id,
      installmentNumber: i.installmentNumber,
      type: i.type,
      dueDate: new Date(i.dueDate),
      scheduledAmount: i.scheduledAmount,
    });
    instByTxn.set(i.transactionId, list);
  }
  const payByTxn = new Map<string, typeof payments>();
  for (const p of payments) {
    const list = payByTxn.get(p.transactionId) ?? [];
    list.push(p);
    payByTxn.set(p.transactionId, list);
  }
  for (const t of txns) {
    // Same waterfall replay as getTransactionSummary, so list rows and the
    // detail page can never disagree.
    const { installments: allocated, credit } = replayAllocation(
      instByTxn.get(t.id) ?? [],
      payByTxn.get(t.id) ?? []
    );
    const fin = getTransactionFinancials(
      {
        totalPayable: t.totalPayable,
        unlinkedConfirmed: credit,
        installments: allocated.map((a) => ({
          installmentNumber: a.installmentNumber,
          type: a.type,
          dueDate: a.dueDate,
          scheduledAmount: a.scheduledAmount,
          confirmedPaid: a.confirmedPaid,
        })),
      },
      now
    );
    out.set(t.id, {
      id: t.id,
      confirmedPaid: fin.totalPaid,
      outstanding: fin.outstanding,
      overdueCount: fin.overdueCount,
      overdueAmount: fin.overdueAmount,
      nextInstallment: fin.nextInstallment,
      isOverdue: fin.isOverdue,
      daysUntilDue: fin.daysUntilDue,
      daysOverdue: fin.daysOverdue,
      isFullyPaid: fin.isFullyPaid,
      isOverpaid: fin.isOverpaid,
      overpaidAmount: fin.overpaidAmount,
      scheduleDeficit: fin.scheduleDeficit,
    });
  }
  return out;
}
