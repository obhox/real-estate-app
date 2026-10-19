import type { Prisma } from "@/generated/prisma/client";
import type { InstallmentStatus } from "@/generated/prisma/enums";
import { createHash } from "node:crypto";
import { lagosDayKey } from "@/lib/time";
import { replayAllocationDetail, type AllocationInstallment, type InstallmentAllocation } from "./allocations";

// Single ledger service (Step 2): the ONLY code allowed to write money
// entries (LedgerEntry) and allocation rows (PaymentAllocation), and to
// compute balances from them. Callers (payment confirmation, void, backfill)
// run these inside their own DB transaction and keep maintaining the legacy
// stored columns (Transaction.totalPaid/outstandingBalance,
// Installment.paidAmount/status) until reads switch over — dual-write, with
// verifyTransactionLedger() proving the two agree.
//
// Money rules (whole-naira Int, never floats):
//   totalPayable = sum(CHARGE_*) - sum(DISCOUNT) - sum(WAIVER)
//   totalPaid    = sum(PAYMENT) - sum(REVERSAL of payments)
//   outstanding  = totalPayable - totalPaid
// Only CONFIRMED payments get PAYMENT entries. PENDING payments live only in
// the Payment table. Voids append a REVERSAL entry — rows are never edited.

export const LEDGER_TYPES = [
  "CHARGE_BASE",
  "CHARGE_INTEREST",
  "CHARGE_FEE",
  "PAYMENT",
  "DISCOUNT",
  "WAIVER",
  "ADJUSTMENT",
  "REVERSAL",
] as const;
export type LedgerEntryType = (typeof LEDGER_TYPES)[number];

const CHARGE_TYPES: ReadonlySet<string> = new Set(["CHARGE_BASE", "CHARGE_INTEREST", "CHARGE_FEE"]);

export type LedgerDirection = "DEBIT" | "CREDIT";

export type TxClient = Prisma.TransactionClient;

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

// Thrown when the stored money columns disagree with the confirmed-payment
// history after a write. Lives here (ledger-domain corruption) so both
// payment confirmation and reversal can raise it without a circular import.
export class PaymentCorruptStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentCorruptStateError";
  }
}

export function logLedgerError(context: string, error: unknown): void {
  console.error(`[ledger] ${context}`, error);
}

// LedgerError messages carry amounts, never internals — safe to surface.
// Anything else becomes a friendly message; details stay server-side.
export function toUserFacingLedgerError(error: unknown): string {
  if (error instanceof LedgerError) return error.message;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  if (code === "P2002") return "This was already recorded. Refresh to see the latest state.";
  if (code === "P2025") return "The record no longer exists. Refresh to see the latest state.";
  if (code === "P2034") return "Someone else just changed this. Refresh and try again.";
  return "Couldn't save. Please try again.";
}

function assertWholeNaira(amount: number, what: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new LedgerError(`${what} must be a positive whole-naira integer, got ${amount}`);
  }
}

// ---------------------------------------------------------------------------
// Allocation planner (pure): waterfall a payment across installments, oldest
// unpaid first, from the targeted installment forward. Returns per-installment
// amounts that sum EXACTLY to paymentAmount, or throws LedgerError when the
// suffix capacity is insufficient (caller must reject, never truncate).
// ---------------------------------------------------------------------------

export type AllocationInput = {
  id: string;
  installmentNumber: number;
  scheduledAmount: number;
  paidAmount: number;
};

export type AllocationStep = { installmentId: string; amount: number };

export function planAllocation(
  ordered: AllocationInput[],
  startInstallmentId: string | null,
  paymentAmount: number
): AllocationStep[] {
  const { plan, remainder } = planAllocationCapped(ordered, startInstallmentId, paymentAmount);
  if (remainder > 0) {
    throw new LedgerError(
      `Payment of ${paymentAmount} exceeds the remaining scheduled ${paymentAmount - remainder} from the targeted installment onward`
    );
  }
  return plan;
}

// Non-throwing variant: allocates what fits and reports the unallocated
// remainder. Used for explicit credit/overpayment (the remainder becomes the
// visible credit balance — never silently truncated or absorbed).
export function planAllocationCapped(
  ordered: AllocationInput[],
  startInstallmentId: string | null,
  paymentAmount: number
): { plan: AllocationStep[]; remainder: number } {
  assertWholeNaira(paymentAmount, "payment amount");
  const sorted = [...ordered].sort((a, b) => a.installmentNumber - b.installmentNumber);
  const startIdx = startInstallmentId ? sorted.findIndex((i) => i.id === startInstallmentId) : 0;
  const suffix = startIdx >= 0 ? sorted.slice(startIdx) : sorted;
  const plan: AllocationStep[] = [];
  let remaining = paymentAmount;
  for (const inst of suffix) {
    if (remaining <= 0) break;
    const capacity = inst.scheduledAmount - inst.paidAmount;
    if (capacity <= 0) continue;
    const alloc = Math.min(remaining, capacity);
    plan.push({ installmentId: inst.id, amount: alloc });
    remaining -= alloc;
  }
  return { plan, remainder: remaining };
}

// Human preview of what a payment will do ("Clears Initial (…). Part-pays
// Month 1 (… of …). Balance after: …"). Pure — shared by the record form and
// tests. Throws LedgerError only for invalid amounts, never for overpayment
// (excess is reported as credit).
export type AllocationPreviewLine = {
  installmentId: string;
  label: string;
  clears: boolean;
  applied: number;
  scheduled: number;
};

export function previewAllocation(
  ordered: (AllocationInput & { label: string })[],
  paymentAmount: number,
  totalPayable: number,
  totalPaidBefore: number
): { lines: AllocationPreviewLine[]; remainder: number; balanceAfter: number } {
  assertWholeNaira(paymentAmount, "payment amount");
  const firstUnpaid = [...ordered]
    .sort((a, b) => a.installmentNumber - b.installmentNumber)
    .find((i) => i.scheduledAmount - i.paidAmount > 0);
  const { plan, remainder } = planAllocationCapped(ordered, firstUnpaid?.id ?? null, paymentAmount);
  const byId = new Map(plan.map((p) => [p.installmentId, p.amount]));
  const lines: AllocationPreviewLine[] = [];
  for (const inst of [...ordered].sort((a, b) => a.installmentNumber - b.installmentNumber)) {
    const applied = byId.get(inst.id) ?? 0;
    if (applied <= 0) continue;
    lines.push({
      installmentId: inst.id,
      label: inst.label,
      clears: applied >= inst.scheduledAmount - inst.paidAmount,
      applied,
      scheduled: inst.scheduledAmount,
    });
  }
  return { lines, remainder, balanceAfter: totalPayable - totalPaidBefore - paymentAmount };
}

// ---------------------------------------------------------------------------
// Shared ledger ordering rule (statements, ledger views, backfill): effective
// date, then charge before payment, then recorded time, then id.
// ---------------------------------------------------------------------------

const TYPE_RANK: Record<string, number> = {
  CHARGE_BASE: 0,
  CHARGE_INTEREST: 0,
  CHARGE_FEE: 0,
  DISCOUNT: 1,
  WAIVER: 1,
  ADJUSTMENT: 1,
  PAYMENT: 2,
  REFUND: 3,
  REVERSAL: 4,
};

export type OrderableEntry = {
  id: string;
  type: string;
  effectiveDate: Date | string;
  createdAt?: Date | string;
};

export function compareLedgerEntries(a: OrderableEntry, b: OrderableEntry): number {
  const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  // Calendar-day ordering in the business zone: a payment stored as a
  // date-only midnight and a charge stored as a noon instant on the SAME day
  // must tie here, so the type priority below (charge before payment) decides
  // instead of the storage clock. Full-timestamp comparison misordered such
  // ties and produced negative running balances (TXN-2026-87153).
  const aDay = lagosDayKey(a.effectiveDate);
  const bDay = lagosDayKey(b.effectiveDate);
  return (
    (aDay < bDay ? -1 : aDay > bDay ? 1 : 0) ||
    (TYPE_RANK[a.type] ?? 9) - (TYPE_RANK[b.type] ?? 9) ||
    aCreated - bCreated ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

export function orderLedgerEntries<T extends OrderableEntry>(entries: T[]): T[] {
  return [...entries].sort(compareLedgerEntries);
}

// Canonical fingerprint of a transaction's ledger: generating a statement
// with an unchanged hash returns the existing statement; any ledger change
// (new/voided/corrected entry) produces a new one.
export function hashLedgerEntries(
  entries: { id: string; type: string; amount: number; direction: string; effectiveDate: Date | string }[]
): string {
  const canonical = orderLedgerEntries(entries)
    .map((e) => [e.id, e.type, e.amount, e.direction, new Date(e.effectiveDate).toISOString()].join("|"))
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

// ---------------------------------------------------------------------------
// Writers (tx-scoped; throw LedgerError on misuse, P2002 on replay)
// ---------------------------------------------------------------------------

export type PostEntryInput = {
  transactionId: string;
  type: LedgerEntryType;
  amount: number;
  direction: LedgerDirection;
  effectiveDate: Date;
  paymentId?: string | null;
  method?: string | null;
  bankReference?: string | null;
  reversesEntryId?: string | null;
  recordedById?: string | null;
  note?: string | null;
  idempotencyKey: string;
};

export async function postLedgerEntry(tx: TxClient, input: PostEntryInput) {
  if (!(LEDGER_TYPES as readonly string[]).includes(input.type)) {
    throw new LedgerError(`Unknown ledger entry type: ${input.type}`);
  }
  assertWholeNaira(input.amount, "ledger amount");
  if (!input.idempotencyKey) throw new LedgerError("idempotencyKey is required");
  return tx.ledgerEntry.create({
    data: {
      transactionId: input.transactionId,
      type: input.type,
      amount: input.amount,
      direction: input.direction,
      effectiveDate: input.effectiveDate,
      paymentId: input.paymentId ?? null,
      method: input.method ?? null,
      bankReference: input.bankReference ?? null,
      reversesEntryId: input.reversesEntryId ?? null,
      recordedById: input.recordedById ?? null,
      note: input.note ?? null,
      idempotencyKey: input.idempotencyKey,
    },
  });
}

export async function postPaymentEntry(
  tx: TxClient,
  opts: {
    transactionId: string;
    paymentId: string;
    amount: number;
    effectiveDate: Date;
    method?: string | null;
    bankReference?: string | null;
    recordedById?: string | null;
    idempotencyKey?: string | null;
  }
) {
  return postLedgerEntry(tx, {
    transactionId: opts.transactionId,
    type: "PAYMENT",
    amount: opts.amount,
    direction: "CREDIT",
    effectiveDate: opts.effectiveDate,
    paymentId: opts.paymentId,
    method: opts.method,
    bankReference: opts.bankReference,
    recordedById: opts.recordedById,
    idempotencyKey: opts.idempotencyKey ?? `payment:${opts.paymentId}`,
  });
}

export async function postAllocations(
  tx: TxClient,
  paymentId: string,
  plan: AllocationStep[]
) {
  const sum = plan.reduce((s, p) => s + p.amount, 0);
  for (const step of plan) {
    assertWholeNaira(step.amount, "allocation amount");
    await tx.paymentAllocation.create({
      data: {
        paymentId,
        installmentId: step.installmentId,
        amount: step.amount,
      },
    });
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Recompute: the single writer of allocation rows. Given a transaction, it
// replays every CONFIRMED payment (date order) through the waterfall from the
// earliest open installment and rewrites the persisted state to match:
//   - PaymentAllocation rows (the audit copy),
//   - each installment's paidAmount + status,
//   - each confirmed payment's isCredit / creditAmount,
// and returns the derived totals. This is what makes the stored columns agree
// with what every read path derives, so dashboard, summary and receipt cannot
// drift. WAIVED installments are never allocated or rewritten.
// ---------------------------------------------------------------------------

export type RecomputeResult = {
  installments: InstallmentAllocation[];
  creditByPayment: Map<string, number>;
  totalPaid: number;
  credit: number;
};

export async function recomputeTransactionAllocations(
  tx: TxClient,
  transactionId: string,
  opts: {
    now?: Date;
    // Injected so ledger.ts never imports paymentConfirmation (avoids a cycle).
    deriveStatus: (confirmedPaid: number, scheduledAmount: number, dueDate: Date, now: Date) => InstallmentStatus;
  }
): Promise<RecomputeResult> {
  const now = opts.now ?? new Date();
  const all = await tx.installment.findMany({
    where: { transactionId },
    orderBy: { installmentNumber: "asc" },
  });
  const active = all.filter((i) => i.status !== "WAIVED");
  const confirmed = await tx.payment.findMany({
    where: { transactionId, status: "CONFIRMED" },
  });
  const detail = replayAllocationDetail(
    active.map(
      (i): AllocationInstallment => ({
        id: i.id,
        installmentNumber: i.installmentNumber,
        type: i.type,
        dueDate: i.dueDate,
        scheduledAmount: i.scheduledAmount,
      })
    ),
    confirmed.map((p) => ({
      id: p.id,
      amount: p.amount,
      paymentDate: p.paymentDate,
      status: p.status,
    }))
  );

  const confirmedIds = confirmed.map((p) => p.id);
  if (confirmedIds.length > 0) {
    await tx.paymentAllocation.deleteMany({ where: { paymentId: { in: confirmedIds } } });
  }

  const creditByPayment = new Map<string, number>();
  for (const pr of detail.payments) {
    for (const a of pr.allocations) {
      assertWholeNaira(a.amount, "allocation amount");
      await tx.paymentAllocation.create({
        data: { paymentId: pr.paymentId, installmentId: a.installmentId, amount: a.amount },
      });
    }
    creditByPayment.set(pr.paymentId, pr.credit);
    await tx.payment.update({
      where: { id: pr.paymentId },
      data: { isCredit: pr.credit > 0, creditAmount: pr.credit > 0 ? pr.credit : null },
    });
  }

  for (const inst of detail.installments) {
    await tx.installment.update({
      where: { id: inst.id },
      data: {
        paidAmount: inst.confirmedPaid,
        status: opts.deriveStatus(inst.confirmedPaid, inst.scheduledAmount, inst.dueDate, now),
        updatedAt: now,
      },
    });
  }

  const totalPaid = detail.installments.reduce((s, i) => s + i.confirmedPaid, 0) + detail.credit;
  return { installments: detail.installments, creditByPayment, totalPaid, credit: detail.credit };
}

// Pre-commit guard: the stored money columns must equal the confirmed-payment
// history, every payment's allocations plus its credit must equal its amount,
// and every installment's stored paid must equal what was allocated to it.
// Throws PaymentCorruptStateError (which fails the whole DB transaction, so no
// receipt is ever written for a corrupt save).
export async function assertTransactionInvariants(
  tx: TxClient,
  transactionId: string,
  opts: { expectedTotalPaid: number }
): Promise<void> {
  const txn = await tx.transaction.findUnique({ where: { id: transactionId } });
  if (!txn) {
    throw new PaymentCorruptStateError("Transaction row disappeared mid-save");
  }
  const payments = await tx.payment.findMany({ where: { transactionId, status: "CONFIRMED" } });
  const confirmedSum = payments.reduce((s, p) => s + p.amount, 0);
  if (txn.totalPaid !== confirmedSum) {
    throw new PaymentCorruptStateError(
      `Stored total paid ${txn.totalPaid} disagrees with confirmed payments ${confirmedSum}`
    );
  }
  const expectedOutstanding = txn.totalPayable - confirmedSum;
  if (txn.outstandingBalance !== expectedOutstanding) {
    throw new PaymentCorruptStateError(
      `Stored outstanding ${txn.outstandingBalance} disagrees with computed ${expectedOutstanding}`
    );
  }
  if (opts.expectedTotalPaid !== confirmedSum) {
    throw new PaymentCorruptStateError(
      `Recomputed total ${opts.expectedTotalPaid} disagrees with confirmed payments ${confirmedSum}`
    );
  }

  const ids = payments.map((p) => p.id);
  const allocs =
    ids.length > 0
      ? await tx.paymentAllocation.findMany({ where: { paymentId: { in: ids } } })
      : [];
  const byPayment = new Map<string, number>();
  const byInstallment = new Map<string, number>();
  for (const a of allocs) {
    byPayment.set(a.paymentId, (byPayment.get(a.paymentId) ?? 0) + a.amount);
    byInstallment.set(a.installmentId, (byInstallment.get(a.installmentId) ?? 0) + a.amount);
  }
  for (const p of payments) {
    const credit = p.isCredit ? (p.creditAmount ?? 0) : 0;
    const allocSum = byPayment.get(p.id) ?? 0;
    if (allocSum + credit !== p.amount) {
      throw new PaymentCorruptStateError(
        `Payment ${p.paymentReference ?? p.id}: allocated ${allocSum} + credit ${credit} != amount ${p.amount}`
      );
    }
  }
  const installments = await tx.installment.findMany({ where: { transactionId } });
  for (const inst of installments) {
    if (inst.status === "WAIVED") continue;
    const allocSum = byInstallment.get(inst.id) ?? 0;
    if ((inst.paidAmount ?? 0) !== allocSum) {
      throw new PaymentCorruptStateError(
        `Installment #${inst.installmentNumber}: stored paid ${inst.paidAmount} != allocated ${allocSum}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Readers: balances derived from entries only
// ---------------------------------------------------------------------------
export type LedgerBalances = {
  totalPayable: number;
  totalPaid: number;
  outstanding: number;
  chargeTotal: number;
  discountTotal: number;
  paymentTotal: number;
  reversalTotal: number;
  entryCount: number;
};

export async function getLedgerBalances(
  tx: TxClient,
  transactionId: string
): Promise<LedgerBalances> {
  const entries = await tx.ledgerEntry.findMany({ where: { transactionId } });
  let chargeTotal = 0;
  let discountTotal = 0;
  let paymentTotal = 0;
  let reversalTotal = 0;
  for (const e of entries) {
    if (CHARGE_TYPES.has(e.type)) chargeTotal += e.amount;
    else if (e.type === "DISCOUNT" || e.type === "WAIVER") discountTotal += e.amount;
    else if (e.type === "PAYMENT") paymentTotal += e.amount;
    else if (e.type === "REVERSAL") reversalTotal += e.amount;
  }
  const totalPayable = chargeTotal - discountTotal;
  const totalPaid = paymentTotal - reversalTotal;
  return {
    totalPayable,
    totalPaid,
    outstanding: totalPayable - totalPaid,
    chargeTotal,
    discountTotal,
    paymentTotal,
    reversalTotal,
    entryCount: entries.length,
  };
}

export async function getPaymentAllocations(tx: TxClient, paymentId: string) {
  return tx.paymentAllocation.findMany({ where: { paymentId } });
}

// Allocation parts for one payment, for allocation-derived "Applied to"
// labels (receipt pages, new receipt PDFs, Payment History). Never falls back
// to the payment's single installment link — a waterfall payment can span
// installments, which is why the old rigid labels misled.
export async function getAllocationLabelParts(
  tx: TxClient,
  paymentId: string
): Promise<{ installmentNumber: number; type: string; amount: number; scheduledAmount: number }[]> {
  const rows = await tx.paymentAllocation.findMany({
    where: { paymentId },
    include: { installment: { select: { installmentNumber: true, type: true, scheduledAmount: true } } },
  });
  return rows.map((r) => ({
    installmentNumber: r.installment.installmentNumber,
    type: r.installment.type,
    amount: r.amount,
    scheduledAmount: r.installment.scheduledAmount,
  }));
}

// ---------------------------------------------------------------------------
// Verification: ledger vs legacy stored columns vs finance-service derivation.
// Returns mismatches (empty = agreement). Used by the backfill script and,
// later, the nightly reconciliation job.
// ---------------------------------------------------------------------------

export type LedgerCheck = {
  transactionRef: string;
  ok: boolean;
  ledger: LedgerBalances;
  stored: { totalPaid: number; outstanding: number };
  installmentPaid: { installmentNumber: number; stored: number; allocated: number }[];
  problems: string[];
};

export async function verifyTransactionLedger(
  tx: TxClient,
  transactionId: string
): Promise<LedgerCheck> {
  const txn = await tx.transaction.findUnique({
    where: { id: transactionId },
    include: { installments: { orderBy: { installmentNumber: "asc" } } },
  });
  if (!txn) throw new LedgerError(`Transaction ${transactionId} not found`);
  const ledger = await getLedgerBalances(tx, transactionId);
  const problems: string[] = [];
  if (ledger.totalPaid !== txn.totalPaid) {
    problems.push(`totalPaid: ledger ${ledger.totalPaid} != stored ${txn.totalPaid}`);
  }
  if (ledger.outstanding !== txn.outstandingBalance) {
    problems.push(`outstanding: ledger ${ledger.outstanding} != stored ${txn.outstandingBalance}`);
  }
  if (ledger.totalPayable !== txn.totalPayable) {
    problems.push(`totalPayable: ledger ${ledger.totalPayable} != stored ${txn.totalPayable}`);
  }
  const allocs = await tx.paymentAllocation.findMany({
    where: { payment: { transactionId } },
  });
  const allocatedByInst = new Map<string, number>();
  for (const a of allocs) {
    allocatedByInst.set(a.installmentId, (allocatedByInst.get(a.installmentId) ?? 0) + a.amount);
  }
  const installmentPaid = txn.installments.map((i) => ({
    installmentNumber: i.installmentNumber,
    stored: i.paidAmount,
    allocated: allocatedByInst.get(i.id) ?? 0,
  }));
  for (const row of installmentPaid) {
    if (row.stored !== row.allocated) {
      problems.push(`installment #${row.installmentNumber}: allocated ${row.allocated} != stored paid ${row.stored}`);
    }
  }
  // Invariant: every confirmed payment has exactly one PAYMENT entry, and
  // allocation sums equal payment amounts — except explicit credit payments,
  // where allocated + creditAmount == amount (the remainder is the visible
  // credit balance, never silently dropped).
  const payments = await tx.payment.findMany({ where: { transactionId, status: "CONFIRMED" } });
  const entries = await tx.ledgerEntry.findMany({ where: { transactionId, type: "PAYMENT" } });
  const entryByPayment = new Map(entries.map((e) => [e.paymentId, e]));
  for (const p of payments) {
    const entry = entryByPayment.get(p.id);
    if (!entry) {
      problems.push(`payment ${p.paymentReference}: no PAYMENT ledger entry`);
      continue;
    }
    if (entry.amount !== p.amount) {
      problems.push(`payment ${p.paymentReference}: entry ${entry.amount} != payment ${p.amount}`);
    }
    const allocSum = allocs.filter((a) => a.paymentId === p.id).reduce((s, a) => s + a.amount, 0);
    const credit = p.isCredit ? (p.creditAmount ?? 0) : 0;
    if (allocSum + credit !== p.amount) {
      problems.push(`payment ${p.paymentReference}: allocated ${allocSum} + credit ${credit} != payment ${p.amount}`);
    }
  }
  return {
    transactionRef: txn.ref,
    ok: problems.length === 0,
    ledger,
    stored: { totalPaid: txn.totalPaid, outstanding: txn.outstandingBalance },
    installmentPaid,
    problems,
  };
}

// ---------------------------------------------------------------------------
// Effective ledger for client statements: reversed payments and their
// REVERSAL lines are excluded (the client sees the confirmed position, with
// no corrections note — the void → replacement trail lives in the Corrections
// panel, the internal ledger view, the activity feed and the correction
// email). The internal ledger view shows everything, unfiltered.
// ---------------------------------------------------------------------------

export type EffectiveEntry = {
  id: string;
  type: string;
  amount: number;
  direction: string;
  effectiveDate: Date;
  createdAt: Date;
  method: string | null;
  bankReference: string | null;
  paymentId: string | null;
  paymentReference: string | null;
  receiptRef: string | null;
  note: string | null;
};

// The shapes selectEffectiveEntries reads. Kept explicit so a caller can
// bulk-fetch every transaction's entries + receipts in ONE query each and
// still run the single shared rule — never a second implementation of it.
export type LedgerEntryRowForEffective = {
  id: string;
  type: string;
  amount: number;
  direction: string;
  effectiveDate: Date;
  createdAt: Date;
  method: string | null;
  bankReference: string | null;
  paymentId: string | null;
  note: string | null;
  reversesEntryId: string | null;
  payment: { paymentReference: string | null } | null;
};

export type ReceiptRowForEffective = { paymentId: string | null; ref: string };

// Pure core of getEffectiveEntries: exclude REVERSAL lines and the entries
// they reverse, attach each payment's receipt ref, and order by the shared
// ledger rule. Shared by the single-transaction and multi-transaction readers.
export function selectEffectiveEntries(
  entries: LedgerEntryRowForEffective[],
  receipts: ReceiptRowForEffective[]
): EffectiveEntry[] {
  const refByPayment = new Map(
    receipts.filter((r) => r.paymentId).map((r) => [r.paymentId as string, r.ref])
  );
  const reversedEntryIds = new Set(
    entries.filter((e) => e.type === "REVERSAL" && e.reversesEntryId).map((e) => e.reversesEntryId as string)
  );
  return orderLedgerEntries(
    entries
      .filter((e) => e.type !== "REVERSAL" && !reversedEntryIds.has(e.id))
      .map((e) => ({
        id: e.id,
        type: e.type,
        amount: e.amount,
        direction: e.direction,
        effectiveDate: e.effectiveDate,
        createdAt: e.createdAt,
        method: e.method,
        bankReference: e.bankReference,
        paymentId: e.paymentId,
        paymentReference: e.payment?.paymentReference ?? null,
        receiptRef: e.paymentId ? (refByPayment.get(e.paymentId) ?? null) : null,
        note: e.note,
      }))
  );
}

export async function getEffectiveEntries(tx: TxClient, transactionId: string): Promise<EffectiveEntry[]> {
  const [entries, receipts] = await Promise.all([
    tx.ledgerEntry.findMany({
      where: { transactionId },
      include: { payment: { select: { paymentReference: true } } },
    }),
    tx.receipt.findMany({ where: { transactionId }, select: { paymentId: true, ref: true } }),
  ]);
  return selectEffectiveEntries(entries, receipts);
}

// ---------------------------------------------------------------------------
// Contract date: the sale date a transaction's charges are effective on.
// Correcting it re-dates the CHARGE entries (sanctioned data fix with an
// audit entry — the previous date was wrongly recorded, as with amounts).
// ---------------------------------------------------------------------------

export async function setTransactionContractDate(
  tx: TxClient,
  opts: { transactionId: string; contractDate: Date; actorId?: string | null; actorName?: string | null; reason?: string | null }
): Promise<{ updatedCharges: number }> {
  const txn = await tx.transaction.findUnique({ where: { id: opts.transactionId } });
  if (!txn) throw new LedgerError(`Transaction ${opts.transactionId} not found`);
  if (Number.isNaN(opts.contractDate.getTime())) throw new LedgerError("Invalid contract date");
  const before = txn.contractDate ?? txn.createdAt;
  await tx.transaction.update({ where: { id: txn.id }, data: { contractDate: opts.contractDate } });
  const charges = await tx.ledgerEntry.updateMany({
    where: { transactionId: txn.id, type: { startsWith: "CHARGE" } },
    data: { effectiveDate: opts.contractDate },
  });
  await tx.auditEvent.create({
    data: {
      actorId: opts.actorId ?? null,
      actorName: opts.actorName ?? "System",
      action: "contract.set_date",
      entityType: "transaction",
      entityId: txn.id,
      before: { contractDate: before },
      after: { contractDate: opts.contractDate, reason: opts.reason ?? null, chargesRedated: charges.count },
    },
  });
  return { updatedCharges: charges.count };
}
