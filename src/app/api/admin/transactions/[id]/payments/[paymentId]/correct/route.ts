import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { generateUniquePaymentRef, generateUniqueReceiptRef } from "@/lib/ref";
import { getAppUrl, getReceiptAccessUrl, generateReceiptAccessToken } from "@/lib/app-url";
import { generateReceiptPdf } from "@/lib/receipts/generateReceiptPdf";
import { generateQrDataUrl } from "@/lib/receipts/qr";
import {
  applyConfirmationDbUnit,
  reverseConfirmedPaymentDbUnit,
  toUserFacingError,
  logServerError,
  isTransientDbError,
} from "@/lib/paymentConfirmation";
import { generateAndStoreReceiptPdf } from "@/lib/receiptDelivery";
import { formatDateDMY, toDateOnlyNoonUtc } from "@/lib/time";

export const maxDuration = 60;

// The correction is only a handful of statements, but against a pooled remote
// database it takes seconds: the original 5s maxWait / 15s timeout pair was
// tight enough that a cold connection failed the whole thing with a P2028 and
// reported only "Couldn't save. Please try again." The unit is atomic, so a
// transient failure left nothing behind and may simply be retried — but only
// while there is room for another full attempt inside maxDuration.
const TX_OPTIONS = { maxWait: 15000, timeout: 25000 };
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 300;
const RETRY_BUDGET_MS = 25_000;


// Correct a CONFIRMED payment: visible reversal of the original plus a
// replacement entry, linked both ways, in ONE database transaction. Never
// edits amounts in place. The replacement is confirmed immediately (new
// receipt), but NOTHING is emailed here — the correction email (replacements
// + corrected statement) is drafted by the system and sent only when an
// admin clicks send.
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; paymentId: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, paymentId } = await ctx.params;
  const startedAt = Date.now();
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const newAmount = Number(body.newAmount);
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const verificationNote = typeof body.verificationNote === "string" ? body.verificationNote.trim() : "";
  if (!Number.isInteger(newAmount) || newAmount <= 0) {
    return NextResponse.json({ error: "Enter a whole-naira corrected amount" }, { status: 400 });
  }
  if (reason.length < 3) return NextResponse.json({ error: "A reason is required" }, { status: 400 });
  if (!verificationNote) {
    return NextResponse.json({ error: "Bank verification evidence is required (statement line, date, confirmer)" }, { status: 400 });
  }
  // Confirmed dates are calendar dates (noon-UTC normalized); the correction
  // record stores the admin-confirmed date for the bank-statement check.
  let dateOverride: Date | null = null;
  if (body.paymentDate) {
    try {
      dateOverride = toDateOnlyNoonUtc(String(body.paymentDate));
    } catch {
      return NextResponse.json({ error: "Invalid payment date" }, { status: 400 });
    }
  }
  const bankOverride = typeof body.bankReference === "string" && body.bankReference.trim() ? body.bankReference.trim() : null;

  // Pre-flight reads, guarded as a unit. A database hiccup in any of them used
  // to escape as a bare 500 with no logged cause and nothing the admin could act on.
  const loadOriginal = () =>
    prisma.payment.findUnique({
      where: { id: paymentId },
      include: { transaction: { select: { id: true, ref: true, outstandingBalance: true, bookingId: true } } },
    });
  let original!: NonNullable<Awaited<ReturnType<typeof loadOriginal>>>;
  // Read before the write: the mid-tx void can briefly drop a sold booking.
  let bookingBefore: { outcome: string | null } | null = null;
  try {
    const found = await loadOriginal();
    if (!found || found.transactionId !== id) {
      return NextResponse.json({ error: "Payment not found for this transaction." }, { status: 404 });
    }
    original = found;
    if (original.status !== "CONFIRMED") {
      return NextResponse.json({ error: "Only confirmed payments can be corrected." }, { status: 409 });
    }
    // Idempotent replay: a replacement already exists for this payment.
    const prior = await prisma.payment.findFirst({ where: { correctsPaymentId: paymentId } });
    if (prior) {
      const priorReceipt = await prisma.receipt.findUnique({ where: { paymentId: prior.id } });
      return NextResponse.json({ payment: prior, receipt: priorReceipt, deduped: true });
    }
    // Post-reversal headroom: the correction must fit without creating credit.
    if (newAmount > original.transaction.outstandingBalance + original.amount) {
      return NextResponse.json({ error: "Corrected amount exceeds the available balance. Record any excess separately as credit." }, { status: 400 });
    }
    bookingBefore = original.transaction.bookingId
      ? await prisma.inspectionBooking.findUnique({ where: { id: original.transaction.bookingId }, select: { outcome: true } })
      : null;
  } catch (e) {
    logServerError(`correct payment ${paymentId}: pre-flight read failed`, e);
    return NextResponse.json({ error: "Couldn't load the payment. Nothing was changed — try again." }, { status: 503 });
  }

  let receiptRef: string;
  let paymentRef: string;
  try {
    receiptRef = await generateUniqueReceiptRef();
    paymentRef = await generateUniquePaymentRef();
  } catch (e) {
    logServerError("correct payment: ref generation failed", e);
    return NextResponse.json({ error: "Couldn't correct payment. Please try again." }, { status: 500 });
  }
  try {
    getAppUrl(); // throws in production when APP_URL is missing — fail before any write
  } catch (e) {
    logServerError("correct payment: missing base URL", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Site URL is not configured." },
      { status: 500 }
    );
  }
  const accessToken = generateReceiptAccessToken();
  const receiptUrl = getReceiptAccessUrl(accessToken);
  const actorName = session!.user.name ?? session!.user.email ?? "Unknown";

  let originalReceiptRef: string | null = null;
  // The original's free-text note (if any) moves verbatim into the correction
  // audit below, then is cleared — after a correction it would be wrong and
  // confusing on the payment row. Display truncates long notes regardless.
  const originalNotes = original.notes ?? null;
  const runCorrection = () =>
    prisma.$transaction(
      async (tx) => {
        // 1. Visible reversal of the original (stored totals move back).
        await reverseConfirmedPaymentDbUnit(tx, {
          paymentId,
          transactionId: id,
          reason: `Correction: ${reason}`,
          actorId: session!.user.id,
          actorName,
        });
        // Preserve the original's free-text note in the audit trail, then
        // clear it — post-correction it would be wrong on the row.
        if (originalNotes) {
          await tx.payment.update({ where: { id: paymentId }, data: { notes: null } });
        }
        // 2. Replacement entry (pending, then confirmed below in the same tx).
        const replacement = await tx.payment.create({          data: {
            transactionId: id,
            installmentId: null,
            paymentReference: paymentRef,
            amount: newAmount,
            paymentDate: dateOverride ?? original.paymentDate,
            paymentMethod: original.paymentMethod,
            bankReference: bankOverride ?? original.bankReference,
            notes: `Corrects ${original.paymentReference}: ${reason}`,
            status: "PENDING_VERIFICATION",
            recordedById: session!.user.id,
            source: "CORRECTION",
            idempotencyKey: `correct:${paymentId}:${paymentRef}`,
            correctsPaymentId: paymentId,
            verificationNote,
          },
        });
        // 3. Confirm the replacement (waterfall, totals, new receipt row).
        const confirmed = await applyConfirmationDbUnit(tx, {
          paymentId: replacement.id,
          transactionId: id,
          confirmedById: session!.user.id,
          confirmedByName: actorName,
          verificationNotes: `Correction of ${original.paymentReference}: ${reason}. ${verificationNote}`,
          receiptRef,
          receiptUrl,
          qrTargetUrl: receiptUrl,
          pdfPath: null,
          accessToken,
        });
        // 4. Void-mark the original receipt (bytes untouched — evidence kept).
        const originalReceipt = await tx.receipt.findUnique({ where: { paymentId } });
        if (originalReceipt) {
          await tx.receipt.update({
            where: { id: originalReceipt.id },
            data: { voidedAt: new Date(), replacedByReceiptId: confirmed.receiptId },
          });
          originalReceiptRef = originalReceipt.ref;
        } else {
          logServerError(`correct payment ${paymentId}: original has no receipt row`, null);
        }
        // 5. Linkage audit (void + confirm audits already written by the units).
        await tx.auditEvent.create({
          data: {
            actorId: session!.user.id,
            actorName,
            action: "payment.correct",
            entityType: "payment",
            entityId: replacement.id,
            before: { paymentId, amount: original.amount },
            after: {
              replacementId: replacement.id,
              amount: newAmount,
              reason,
              verificationNote,
              paymentDate: (dateOverride ?? original.paymentDate).toISOString(),
              bankReference: bankOverride ?? original.bankReference,
              originalNotes,
              originalReceiptRef,
              replacementReceiptRef: receiptRef,
            },
          },
        });
        // 6. Undo an accidental booking flip: the mid-tx void may have dropped
        // a sold booking to interested when it briefly saw zero confirmed
        // money; the replacement restores the sale in the same unit.
        if (bookingBefore?.outcome === "sold" && original.transaction.bookingId) {
          const linked = await tx.inspectionBooking.findUnique({ where: { id: original.transaction.bookingId } });
          if (linked && linked.outcome === "interested") {
            await tx.inspectionBooking.update({ where: { id: linked.id }, data: { outcome: "sold" } });
            await tx.bookingActivity.create({
              data: {
                bookingId: linked.id,
                actorId: session!.user.id,
                actorName,
                action: "record_outcome",
                fromStatus: linked.status,
                toStatus: linked.status,
                note: "Auto: restored to Sold — correction replaced the voided payment in the same unit",
              },
            });
          }
        }
        return { replacementId: replacement.id, receiptId: confirmed.receiptId };
      },
      TX_OPTIONS
    );

  // Atomic: a failure means nothing was written, so a transient failure is safe
  // to retry. The attempt that failed may nonetheless have committed — the
  // response is what was lost — so look for a replacement before retrying, and
  // only retry while another full attempt still fits inside maxDuration.
  let outcome: Awaited<ReturnType<typeof runCorrection>> | null = null;
  let failure: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      outcome = await runCorrection();
      break;
    } catch (e) {
      failure = e;
      if (!isTransientDbError(e)) break;
      const committed = await prisma.payment.findFirst({ where: { correctsPaymentId: paymentId } }).catch((lookupError) => {
        logServerError(`correct payment ${paymentId}: post-failure replay check failed`, lookupError);
        return null;
      });
      if (committed) {
        const committedReceipt = await prisma.receipt.findUnique({ where: { paymentId: committed.id } }).catch((lookupError) => {
          logServerError(`correct payment ${paymentId}: post-failure receipt lookup failed`, lookupError);
          return null;
        });
        logServerError(`correct payment ${paymentId}: attempt ${attempt} reported a failure but committed`, e);
        return NextResponse.json({ payment: committed, receipt: committedReceipt, deduped: true });
      }
      if (attempt >= MAX_ATTEMPTS || Date.now() - startedAt >= RETRY_BUDGET_MS) break;
      logServerError(`correct payment ${paymentId}: attempt ${attempt} failed, retrying once`, e);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    }
  }
  if (!outcome) {
    logServerError(`correct payment ${paymentId}`, failure);
    // Transient failures answer 503 (retryable); a rejection of the request
    // itself answers 500. Either way the message says whether anything changed.
    return NextResponse.json({ error: toUserFacingError(failure, "save") }, { status: isTransientDbError(failure) ? 503 : 500 });
  }
  const { replacementId, receiptId } = outcome;

  // ---- Post-commit: render + store the replacement PDF (never emailed here) ----
  // Everything below the commit is best-effort. A failure here must report what
  // landed and what still needs doing — a bare 500 would read as "nothing was
  // saved" and invite the admin to correct the payment a second time.
  const committedButUnprepared = (what: string) =>
    NextResponse.json({
      replacement: { id: replacementId },
      receipt: { id: receiptId, ref: receiptRef },
      originalReceiptRef,
      warning: `Correction committed, but ${what}. Retry from the receipt page.`,
    });
  try {
    const replacement = await prisma.payment.findUnique({
      where: { id: replacementId },
      include: {
        transaction: { include: { installments: true, paymentPlan: true } },
        installment: true,
      },
    });
    if (!replacement || !replacement.transaction) {
      logServerError(`correct payment ${paymentId}: replacement ${replacementId} not reloadable after commit`, null);
      return committedButUnprepared("the replacement could not be reloaded");
    }
    const txn = replacement.transaction;
    const issuedDateStr = formatDateDMY(replacement.paymentDate);
    const { buildReceiptHistory, buildAccountRef, settlementCopy } = await import("@/lib/receipt-amounts");
    const [allConfirmed, allReceipts, bookingRow] = await Promise.all([
      prisma.payment.findMany({ where: { transactionId: txn.id, status: "CONFIRMED" }, select: { id: true, amount: true, paymentDate: true, paymentMethod: true } }),
      prisma.receipt.findMany({ where: { transactionId: txn.id }, select: { paymentId: true, ref: true } }),
      txn.bookingId ? prisma.inspectionBooking.findUnique({ where: { id: txn.bookingId }, select: { ref: true } }) : null,
    ]);
    const refByPayment = new Map(allReceipts.map((r) => [r.paymentId as string, r.ref]));
    refByPayment.set(replacement.id, receiptRef);
    const confirmedTotal = allConfirmed.reduce((s, p) => s + p.amount, 0);
    const history = buildReceiptHistory(
      allConfirmed.map((p) => ({ id: p.id, date: p.paymentDate, method: p.paymentMethod ?? "Bank Transfer", amount: p.amount })),
      refByPayment,
      replacement.id,
      txn.totalPayable,
      formatDateDMY
    );
    const qrDataUrl = await generateQrDataUrl(receiptUrl).catch((e) => {
      logServerError(`receipt ${receiptRef}: QR generation failed`, e);
      return undefined;
    });
    const settlement = settlementCopy({
      balanceAfter: txn.totalPayable - confirmedTotal,
      settledOn: replacement.paymentDate,
      scheduledEnd: txn.installments[txn.installments.length - 1]?.dueDate ?? null,
      formatDate: formatDateDMY,
    });
    const pdfOutcome = await generateAndStoreReceiptPdf({
      db: prisma,
      receiptId,
      ref: receiptRef,
      render: () =>
        generateReceiptPdf({
          ref: receiptRef,
          issuedDate: formatDateDMY(new Date()),
          clientName: txn.customerName,
          clientAddress: `${txn.estate} · ${txn.unitType ?? "Plot"} · ${txn.plotCode ?? txn.ref}`,
          clientPhone: txn.customerPhone ?? "",
          clientEmail: txn.customerEmail,
          estateName: txn.estate,
          unitType: txn.unitType ?? "Plot",
          plotCode: txn.plotCode ?? txn.ref,
          amountPaid: replacement.amount,
          soldPrice: txn.baseAmount,
          discount: 0,
          payments: [{ date: issuedDateStr, method: replacement.paymentMethod ?? "Bank Transfer", amount: replacement.amount }],
          history: history.map((h) => ({ date: h.date, method: h.method, amount: h.amount, receiptRef: h.receiptRef, runningBalance: h.runningBalance, isCurrent: h.isCurrent })),
          accountRef: buildAccountRef(txn.ref, bookingRow?.ref ?? null),
          replacesRef: originalReceiptRef,
          label: settlement.headline,
          settlementNote: settlement.note,
          paymentDate: issuedDateStr,
          paymentMethodLabel: replacement.paymentMethod ?? "Bank Transfer",
          bankReference: replacement.bankReference ?? null,
          receiptUrl,
          qrDataUrl,
          unitPrice: txn.unitPrice,
          plotQuantity: txn.plotQuantity,
          paymentPlanName: txn.paymentPlan?.name,
          interestAmount: txn.interestAmount,
          totalPayable: txn.totalPayable,
          previouslyPaid: confirmedTotal - replacement.amount,
          totalPaidAfter: confirmedTotal,
          outstandingBalance: txn.totalPayable - confirmedTotal,
          transactionRef: txn.ref,
        }),
    });
    if (!pdfOutcome.ok) {
      return committedButUnprepared("the replacement PDF failed");
    }
    return NextResponse.json({
      replacement: { id: replacementId },
      receipt: { id: receiptId, ref: receiptRef },
      originalReceiptRef,
      needsEmail: true,
    });
  } catch (e) {
    logServerError(`correct payment ${paymentId}: post-commit receipt render failed`, e);
    return committedButUnprepared("the replacement receipt could not be prepared");
  }
}
