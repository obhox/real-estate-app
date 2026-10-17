import type { Prisma } from "@/generated/prisma/client";
import { amountToWords } from "./receipts/amountToWords";
import { formatDateDMY } from "./time";
import {
  postPaymentEntry,
  postLedgerEntry,
  recomputeTransactionAllocations,
  assertTransactionInvariants,
  PaymentCorruptStateError,
} from "./finance/ledger";

// Corruption is a ledger-domain failure; the class lives in ledger.ts so the
// recompute/assert helpers can raise it without a circular import. Re-exported
// here so existing import paths (routes, toUserFacingError) keep working.
export { PaymentCorruptStateError };

// Shared payment-confirmation core: database work ONLY. No PDF rendering,
// no filesystem access, no email, no network. Slow or fallible side effects
// live in receiptDelivery.ts and run after the transaction commits, so a
// >5s PDF render or SMTP stall can never roll back a confirmation.

export type TxClient = Prisma.TransactionClient;

export type DeliveryState = "PENDING" | "GENERATED" | "FAILED" | "SENT";

export type InstallmentStatusLabel =
  | "PENDING"
  | "DUE"
  | "PAID"
  | "PARTIALLY_PAID"
  | "OVERDUE"
  | "WAIVED";

// Typed failures — routes map these to user-friendly messages via
// toUserFacingError() and never leak them to the client raw.
export class PaymentAlreadyHandledError extends Error {
  constructor(paymentId: string) {
    super(`Payment ${paymentId} is no longer pending (already confirmed, voided, or failed)`);
    this.name = "PaymentAlreadyHandledError";
  }
}

// The ONLY payment gate: cumulative confirmed payments (existing ledger
// total + the new payment) must not exceed the account's total balance.
// Generic — amounts only, never customer-specific. Thrown inside the same
// DB transaction that writes the ledger entry, so the check and the write
// are atomic (concurrent confirms serialize on the transaction row lock).
export class TotalBalanceExceededError extends Error {
  readonly existingTotal: number;
  readonly amount: number;
  readonly totalPayable: number;
  constructor(existingTotal: number, amount: number, totalPayable: number) {
    super(
      `Payment of ${amount} would exceed the outstanding ${totalPayable - existingTotal} (total ${totalPayable}, already ${existingTotal} recorded)`
    );
    this.name = "TotalBalanceExceededError";
    this.existingTotal = existingTotal;
    this.amount = amount;
    this.totalPayable = totalPayable;
  }
}

// Legacy guard, kept for backward compatibility (routes still catch it and
// pure-function tests still cover it). Nothing in the record/confirm flow
// throws it anymore — over-schedule money auto-parks as visible credit.
export class OverScheduleError extends Error {
  readonly paidAmount: number;
  readonly amount: number;
  readonly scheduledAmount: number;
  constructor(paidAmount: number, amount: number, scheduledAmount: number) {
    super(
      `Payment of ${amount} would exceed the scheduled ${scheduledAmount} (already ${paidAmount} recorded against this installment)`
    );
    this.name = "OverScheduleError";
    this.paidAmount = paidAmount;
    this.amount = amount;
    this.scheduledAmount = scheduledAmount;
  }
}

// Status derives from CONFIRMED money only. Pending (unverified) payments
// never count as paid — they must not move an installment off Due/Late.
export function deriveInstallmentStatus(
  confirmedPaid: number,
  scheduledAmount: number,
  dueDate: Date,
  now: Date = new Date()
): InstallmentStatusLabel {
  if (confirmedPaid >= scheduledAmount) return "PAID";
  if (confirmedPaid > 0) return dueDate < now ? "OVERDUE" : "PARTIALLY_PAID";
  if (dueDate < now) return "OVERDUE";
  return dueDate.toDateString() === now.toDateString() ? "DUE" : "PENDING";
}

// Legacy predicate, kept for backward compatibility (tests still cover it).
// It is no longer used as a gate anywhere: any positive whole-naira amount
// records and confirms, with schedule excess parked as visible credit.
export function wouldExceedSchedule(
  confirmedPaid: number,
  pendingSum: number,
  newAmount: number,
  scheduledAmount: number
): boolean {
  return confirmedPaid + pendingSum + newAmount > scheduledAmount;
}

// Never render these raw: Prisma messages carry constraint names, table
// names, and driver detail that mean nothing to an admin and may leak paths.
export function toUserFacingError(error: unknown, action: "confirm" | "record" | "void" | "save" | "booking"): string {
  const verb =
    action === "confirm"
      ? "confirm payment"
      : action === "record"
        ? "record payment"
        : action === "void"
          ? "void payment"
          : action === "booking"
            ? "update booking"
            : "save";
  if (error instanceof PaymentAlreadyHandledError) {
    return action === "confirm"
      ? "This payment was already confirmed or voided. Refresh to see the latest state."
      : "This payment is no longer pending. Refresh to see the latest state.";
  }
  if (error instanceof TotalBalanceExceededError) {
    const outstanding = error.totalPayable - error.existingTotal;
    return (
      `This payment of ₦${error.amount.toLocaleString("en-NG")} exceeds the outstanding balance of ₦${outstanding.toLocaleString("en-NG")} ` +
      `(₦${error.existingTotal.toLocaleString("en-NG")} already paid of ₦${error.totalPayable.toLocaleString("en-NG")} total). ` +
      `Reduce the amount — payments above the outstanding balance are rejected.`
    );
  }
  if (error instanceof OverScheduleError) {
    return (
      `This would exceed the remaining scheduled amount of ₦${error.scheduledAmount.toLocaleString("en-NG")} ` +
      `(₦${error.paidAmount.toLocaleString("en-NG")} already recorded on the schedule from this installment onward). ` +
      `Split the payment or record a smaller amount.`
    );
  }
  if (error instanceof PaymentCorruptStateError) {
    return "The payment data looks inconsistent, so nothing was changed. Ask engineering to review the audit log.";
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  if (code === "P2002") return "This was already recorded. Refresh to see the latest state.";
  if (code === "P2025") return "The record no longer exists. Refresh to see the latest state.";
  if (code === "P2034") return "Someone else just changed this. Refresh and try again.";
  if (code === "P2022") return "Database update pending: deploy the latest migrations, then retry.";
  return `Couldn't ${verb}. Please try again.`;
}

export function logServerError(context: string, error: unknown): void {
  // No structured logger exists in this codebase — console.error with context.
  console.error(`[payments] ${context}`, error);
}

export type ConfirmDbInput = {
  paymentId: string;
  transactionId: string;
  confirmedById?: string | null;
  confirmedByName?: string | null;
  verificationNotes?: string | null;
  receiptRef: string; // pre-generated BEFORE the transaction (DB uniqueness rechecked by constraint)
  receiptUrl: string; // tokenized client URL ({APP_URL}/r/{accessToken})
  qrTargetUrl: string;
  // Legacy disk path (pre-pdfData rows). New rows store the PDF bytes on
  // the receipt row itself (pdfData) — no filesystem. Optional so request
  // paths never need receipt-storage.
  pdfPath?: string | null;
  accessToken: string; // random 32-byte URL-safe token backing receiptUrl
};

export type ConfirmDbResult = {
  payment: { id: string; amount: number; paymentDate: Date; paymentMethod: string | null };
  installment: { id: string; type: string; installmentNumber: number } | null;
  transactionId: string;
  receiptId: string;
  newTotalPaid: number;
  newOutstanding: number;
  isPaidInFull: boolean;
};

// Atomic DB unit for confirmation: claim the payment, move the installment,
// recompute totals, create the receipt row (delivery PENDING — the PDF and
// email happen post-commit). Throws PaymentAlreadyHandledError when the
// payment is no longer pending. Any positive whole-naira amount confirms —
// schedule excess parks as visible credit, never blocks. Everything here is
// tx.* only.
export async function applyConfirmationDbUnit(tx: TxClient, input: ConfirmDbInput): Promise<ConfirmDbResult> {
  const now = new Date();

  // Serialize concurrent confirms on the transaction row: the UPDATE takes a
  // row lock, so a second confirm waits here, then re-reads the first's
  // committed total below — two payments racing cannot together exceed the
  // total balance. (Reads alone would not block; the write lock is the gate.)
  await tx.transaction.update({ where: { id: input.transactionId }, data: { updatedAt: now } });

  // Idempotent claim: exactly one confirmer can flip PENDING→CONFIRMED.
  const claimed = await tx.payment.updateMany({
    where: { id: input.paymentId, transactionId: input.transactionId, status: "PENDING_VERIFICATION" },
    data: {
      status: "CONFIRMED",
      confirmedAt: now,
      confirmedById: input.confirmedById ?? undefined,
      verificationNotes: input.verificationNotes ?? undefined,
      updatedAt: now,
    },
  });
  if (claimed.count === 0) throw new PaymentAlreadyHandledError(input.paymentId);

  const payment = await tx.payment.findUnique({
    where: { id: input.paymentId },
    include: {
      transaction: { include: { installments: true, paymentPlan: true } },
    },
  });
  if (!payment) throw new PaymentCorruptStateError("Confirmed payment row disappeared mid-transaction");

  const transaction = payment.transaction;
  // The ONLY gate (applies to every account, no per-installment checks): the
  // cumulative confirmed total including this payment must not exceed the
  // account's total balance. Any amount at or below the remaining balance
  // confirms freely — smaller than, larger than, or out of order with any
  // single installment. Read inside this transaction, after the row lock
  // above, so the check and the ledger writes below are atomic.
  const confirmedNow = await tx.payment.findMany({
    where: { transactionId: transaction.id, status: "CONFIRMED" },
  });
  const totalAfterClaim = confirmedNow.reduce((sum, p) => sum + p.amount, 0);
  if (totalAfterClaim > transaction.totalPayable) {
    const existingTotal = totalAfterClaim - payment.amount;
    throw new TotalBalanceExceededError(existingTotal, payment.amount, transaction.totalPayable);
  }
  // Resolve the installment pointer: the payment's own, else the next unpaid
  // one. This is display metadata only (the receipt's payment description);
  // the money itself is placed by the waterfall recompute below, which never
  // trusts this pointer.
  let installment =
    payment.installmentId != null
      ? await tx.installment.findUnique({ where: { id: payment.installmentId } })
      : null;
  if (!installment) {
    const next = transaction.installments.find(
      (i) => i.status !== "PAID" && i.status !== "WAIVED"
    );
    if (next) {
      installment = await tx.installment.findUnique({ where: { id: next.id } });
      if (installment) {
        await tx.payment.update({ where: { id: payment.id }, data: { installmentId: installment.id } });
      }
    }
  }

  // Single writer for allocations: replay every confirmed payment (including
  // this one) through the waterfall from the earliest open installment, then
  // rewrite the PaymentAllocation rows, each installment's paid/status, and
  // each payment's credit to match. One uniform rule — the same one every read
  // path derives from — so the stored columns can never drift.
  const recomputed = await recomputeTransactionAllocations(tx, transaction.id, {
    now,
    deriveStatus: deriveInstallmentStatus,
  });

  // Ledger entry (same tx): the PAYMENT record for this confirmation. The
  // recompute owns the allocation rows; the ledger owns the money entry.
  await postPaymentEntry(tx, {
    transactionId: transaction.id,
    paymentId: payment.id,
    amount: payment.amount,
    effectiveDate: new Date(payment.paymentDate),
    method: payment.paymentMethod,
    bankReference: payment.bankReference,
    recordedById: input.confirmedById ?? null,
  });

  const newTotalPaid = recomputed.totalPaid;
  const newOutstanding = transaction.totalPayable - newTotalPaid;
  if (newOutstanding < 0 && recomputed.credit <= 0) {
    // Negative outstanding is the visible credit balance (money confirmed past
    // the schedule). The total-balance gate above rejects new over-balance
    // payments, so a negative balance with no credit anywhere is corruption.
    throw new PaymentCorruptStateError("Confirmed payments exceed the transaction total");
  }
  const isPaidInFull = newOutstanding <= 0;

  await tx.transaction.update({
    where: { id: transaction.id },
    data: {
      totalPaid: newTotalPaid,
      outstandingBalance: newOutstanding,
      status: isPaidInFull ? "PAID_IN_FULL" : transaction.status,
      updatedAt: now,
    },
  });

  if (isPaidInFull) {
    await tx.installment.updateMany({
      where: { transactionId: transaction.id, status: { notIn: ["PAID", "WAIVED"] } },
      data: { status: "PAID" },
    });
  }

  // Fail the whole save (no receipt) if stored money disagrees with the
  // confirmed-payment history.
  await assertTransactionInvariants(tx, transaction.id, { expectedTotalPaid: newTotalPaid });

  const issuedDateStr = formatDateDMY(payment.paymentDate);
  const receipt = await tx.receipt.create({
    data: {
      ref: input.receiptRef,
      bookingId: transaction.bookingId,
      transactionId: transaction.id,
      paymentId: payment.id,
      source: "PAYMENT_CONFIRMATION",
      property: `${transaction.estate} · ${transaction.unitType ?? ""} · ${transaction.plotCode ?? ""}`.trim(),
      estate: transaction.estate,
      plotCode: transaction.plotCode,
      unitType: transaction.unitType,
      sqm: transaction.sqm,
      customerName: transaction.customerName,
      customerEmail: transaction.customerEmail,
      customerPhone: transaction.customerPhone,
      amountBeforeDiscount: transaction.baseAmount,
      discount: 0,
      finalAmount: payment.amount,
      amountInWords: amountToWords(payment.amount),
      currency: "NGN",
      paymentDescription: describePayment(installment, transaction),
      paymentMethod: payment.paymentMethod,
      paymentHistory: [{ date: issuedDateStr, method: payment.paymentMethod ?? "Bank Transfer", amount: payment.amount }],
      unitPrice: transaction.unitPrice,
      plotQuantity: transaction.plotQuantity,
      paymentPlanCode: transaction.paymentPlan?.code ?? null,
      paymentPlanName: transaction.paymentPlan?.name ?? null,
      issuedAt: new Date(payment.paymentDate),
      recipientEmail: transaction.customerEmail,
      pdfStatus: "PENDING",
      receiptUrl: input.receiptUrl,
      qrTargetUrl: input.qrTargetUrl,
      pdfPath: input.pdfPath ?? null,
      accessToken: input.accessToken,
      createdById: input.confirmedById ?? undefined,
    },
  });

  // Immutable audit row in the same unit: who confirmed what. Email is sent
  // post-commit by the caller (direct Resend send, no queue) — delivery state
  // lives in Resend's dashboard, not here.
  await tx.auditEvent.create({
    data: {
      actorId: input.confirmedById ?? null,
      actorName: input.confirmedByName ?? "System",
      action: "payment.confirm",
      entityType: "payment",
      entityId: payment.id,
      before: { status: "PENDING_VERIFICATION", amount: payment.amount },
      after: { status: "CONFIRMED", amount: payment.amount, receiptRef: input.receiptRef },
    },
  });

  return {
    payment: {
      id: payment.id,
      amount: payment.amount,
      paymentDate: new Date(payment.paymentDate),
      paymentMethod: payment.paymentMethod,
    },
    installment: installment
      ? { id: installment.id, type: installment.type, installmentNumber: installment.installmentNumber }
      : null,
    transactionId: transaction.id,
    receiptId: receipt.id,
    newTotalPaid,
    newOutstanding,
    isPaidInFull,
  };
}

// Human payment description, e.g.
// "Initial payment — Belgrove Peninsula, 3-Bedroom Terrace Duplex (PEN-150SQM)".
// Never "Payment for Initial Payment".
export function describePayment(
  installment: { type: string; installmentNumber: number } | null,
  transaction: { estate: string; unitType?: string | null; plotCode?: string | null }
): string {
  const kind =
    !installment || installment.type === "INITIAL" ? "Initial payment" : `Month ${installment.installmentNumber} payment`;
  const unit = transaction.unitType ? `, ${transaction.unitType}` : "";
  const plot = transaction.plotCode ? ` (${transaction.plotCode})` : "";
  return `${kind}: ${transaction.estate}${unit}${plot}`;
}

export type VoidDbResult = {
  paymentId: string;
  newTotalPaid: number;
  newOutstanding: number;
};

// Atomic reversal of a CONFIRMED payment: payment→CANCELLED, the confirmed
// amount subtracted back off its installment, totals recomputed. The receipt
// row is intentionally left in place as an audit trail (it no longer counts
// toward totals). Pending payments are voided without touching totals.
export async function reverseConfirmedPaymentDbUnit(
  tx: TxClient,
  input: { paymentId: string; transactionId: string; reason?: string | null; actorId?: string | null; actorName?: string | null }
): Promise<VoidDbResult> {
  const now = new Date();

  const claimed = await tx.payment.updateMany({
    where: { id: input.paymentId, transactionId: input.transactionId, status: "CONFIRMED" },
    data: {
      status: "CANCELLED",
      verificationNotes: input.reason ? `Voided (reversal): ${input.reason}` : "Voided (reversal of confirmed payment)",
      updatedAt: now,
    },
  });
  if (claimed.count === 0) throw new PaymentAlreadyHandledError(input.paymentId);

  const payment = await tx.payment.findUnique({ where: { id: input.paymentId } });
  if (!payment) throw new PaymentCorruptStateError("Voided payment row disappeared mid-transaction");

  const transaction = await tx.transaction.findUnique({
    where: { id: input.transactionId },
    include: { installments: true },
  });
  if (!transaction) throw new PaymentCorruptStateError("Transaction row disappeared mid-transaction");

  // The voided payment is no longer confirmed, so drop its allocation rows
  // explicitly (the recompute below only rewrites rows for payments that
  // remain confirmed). Then replay the surviving confirmed history to rebuild
  // the schedule — a reversal is exactly the same uniform rule applied to one
  // fewer payment, so interleaved confirms/voids can never drift the books.
  await tx.paymentAllocation.deleteMany({ where: { paymentId: payment.id } });
  const recomputed = await recomputeTransactionAllocations(tx, transaction.id, {
    now,
    deriveStatus: deriveInstallmentStatus,
  });
  const newTotalPaid = recomputed.totalPaid;
  const newOutstanding = transaction.totalPayable - newTotalPaid;

  await tx.transaction.update({
    where: { id: transaction.id },
    data: {
      totalPaid: newTotalPaid,
      outstandingBalance: newOutstanding,
      // A paid-in-full transaction that loses a payment becomes active
      // again — unless a credit balance remains (outstanding still <= 0).
      // DRAFT is preserved — nothing here promotes a draft.
      status: newOutstanding <= 0 ? "PAID_IN_FULL" : transaction.status === "DRAFT" ? "DRAFT" : "ACTIVE",
      updatedAt: now,
    },
  });

  // Fail the whole void (no audit row) if stored money disagrees with the
  // surviving confirmed history.
  await assertTransactionInvariants(tx, transaction.id, { expectedTotalPaid: newTotalPaid });

  // Ledger dual-write (same tx): a REVERSAL DEBIT against the original
  // PAYMENT entry. This payment's allocation rows were removed above (they are
  // attribution of live money — the REVERSAL entry is the money record).
  // Pre-ledger rows have no PAYMENT entry (backfill ordering); skipping the
  // REVERSAL then is safe — the stored reversal above still applies — but it
  // is logged loudly so the gap is visible.
  const paymentEntry = await tx.ledgerEntry.findUnique({ where: { paymentId: payment.id } });
  if (paymentEntry) {
    await postLedgerEntry(tx, {
      transactionId: transaction.id,
      type: "REVERSAL",
      amount: payment.amount,
      direction: "DEBIT",
      effectiveDate: now,
      reversesEntryId: paymentEntry.id,
      recordedById: input.actorId ?? null,
      note: input.reason ? `Void: ${input.reason}` : "Void of confirmed payment",
      idempotencyKey: `reversal:${payment.id}`,
    });
  } else {
    logServerError(`void payment ${payment.id}: no PAYMENT ledger entry (pre-backfill row?)`, null);
  }

  await tx.auditEvent.create({
    data: {
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? "System",
      action: "payment.void",
      entityType: "payment",
      entityId: payment.id,
      before: { status: "CONFIRMED", amount: payment.amount },
      after: { status: "CANCELLED", amount: payment.amount, reason: input.reason ?? null },
    },
  });

  // Undoing the sale: with no confirmed money left on the transaction, a
  // linked booking the sale auto-marked Sold returns to Interested — the
  // only state the auto-flip ever moves out of. (No transaction-cancel flow
  // exists today; voiding the last confirmed payment is the closest thing
  // to "the sale is off".)
  if (newTotalPaid === 0 && transaction.bookingId) {
    const linked = await tx.inspectionBooking.findUnique({ where: { id: transaction.bookingId } });
    if (linked && linked.outcome === "sold") {
      await tx.inspectionBooking.update({
        where: { id: linked.id },
        data: { outcome: "interested", updatedAt: now },
      });
      await tx.bookingActivity.create({
        data: {
          bookingId: linked.id,
          actorId: input.actorId ?? null,
          actorName: input.actorName ?? "System",
          action: "record_outcome",
          fromStatus: linked.status,
          toStatus: linked.status,
          note: "Auto: reverted to Interested — no confirmed payments remain",
        },
      });
    }
  }

  return { paymentId: payment.id, newTotalPaid, newOutstanding };
}
