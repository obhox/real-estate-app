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
  nextInstallment: NextInstallmentDue | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
  daysOverdue: number | null;
  isFullyPaid: boolean;
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
  // Confirm against money, not the stored label: per-installment paid is the
  // waterfall replay of the transaction's confirmed payments, so an
  // installment whose schedule is genuinely covered is never overdue even if
  // its stored status lags.
  const payments = await db.payment.findMany({
    where: { status: "CONFIRMED", transactionId: { in: [...new Set(rows.map((r) => r.transactionId))] } },
    select: { id: true, amount: true, paymentDate: true, status: true, installmentId: true, transactionId: true },
  });
  const instByTxn = new Map<string, AllocationInstallment[]>();
  for (const r of rows) {
    const list = instByTxn.get(r.transactionId) ?? [];
    list.push({ id: r.id, installmentNumber: r.installmentNumber, type: r.type, dueDate: new Date(r.dueDate), scheduledAmount: r.scheduledAmount });
    instByTxn.set(r.transactionId, list);
  }
  const paidByInst = new Map<string, number>();
  for (const [txnId, insts] of instByTxn) {
    const { installments: allocated } = replayAllocation(
      insts,
      payments.filter((p) => p.transactionId === txnId)
    );
    for (const a of allocated) paidByInst.set(a.id, a.confirmedPaid);
  }
  return rows
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
  // Per-installment paid is the waterfall replay of this transaction's
  // confirmed payments — the same rule the schedule, next-due, overdue lists,
  // receipts and statements read. The Payment.installmentId pointer never
  // moves a money figure; it only hints which row shows a pending payment.
  const { views, credit } = deriveInstallmentViews(
    txn.installments.map((i) => ({
      id: i.id,
      installmentNumber: i.installmentNumber,
      type: i.type,
      dueDate: new Date(i.dueDate),
      scheduledAmount: i.scheduledAmount,
    })),
    payments.map((p) => ({ id: p.id, amount: p.amount, paymentDate: new Date(p.paymentDate), status: p.status })),
    now,
    pendingByInst
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
    nextInstallment: fin.nextInstallment,
    isOverdue: fin.isOverdue,
    daysUntilDue: fin.daysUntilDue,
    daysOverdue: fin.daysOverdue,
    isFullyPaid: fin.isFullyPaid,
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
  outstanding: number;
  progressPct: number;
  nextInstallment: NextInstallmentDue | null;
  overdueCount: number;
  isOverdue: boolean;
  // Calendar-day distance (Lagos) from today to the next due date.
  // Exactly one is non-null when a next installment exists.
  daysUntilDue: number | null;
  daysOverdue: number | null;
  isFullyPaid: boolean;
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

  // Unlinked confirmed money covers the earliest dues first.
  let carry = txn.unlinkedConfirmed ?? 0;
  let nextInstallment: NextInstallmentDue | null = null;
  let overdueCount = 0;
  for (const i of ordered) {
    const due = Math.max(0, i.scheduledAmount - i.confirmedPaid - carry);
    carry = Math.max(0, i.confirmedPaid + carry - i.scheduledAmount);
    if (due <= 0) continue;
    if (!nextInstallment) {
      nextInstallment = { number: i.installmentNumber, type: i.type, amountDue: due, dueDate: new Date(i.dueDate) };
    }
    if (lagosDayKey(i.dueDate) < todayKey) overdueCount += 1;
  }

  let daysUntilDue: number | null = null;
  let daysOverdue: number | null = null;
  if (nextInstallment) {
    const diff = dayKeyDiff(todayKey, lagosDayKey(nextInstallment.dueDate));
    if (diff < 0) daysOverdue = -diff;
    else daysUntilDue = diff;
  }
  const isFullyPaid = outstanding <= 0 && !nextInstallment;
  return {
    totalPayable: txn.totalPayable,
    totalPaid,
    outstanding,
    progressPct: txn.totalPayable > 0 ? Math.round((totalPaid / txn.totalPayable) * 10000) / 100 : 0,
    nextInstallment,
    overdueCount,
    isOverdue: overdueCount > 0,
    daysUntilDue,
    daysOverdue,
    isFullyPaid,
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
  nextInstallment: NextInstallmentDue | null;
  isOverdue: boolean;
  daysUntilDue: number | null;
  daysOverdue: number | null;
  isFullyPaid: boolean;
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
      nextInstallment: fin.nextInstallment,
      isOverdue: fin.isOverdue,
      daysUntilDue: fin.daysUntilDue,
      daysOverdue: fin.daysOverdue,
      isFullyPaid: fin.isFullyPaid,
    });
  }
  return out;
}
