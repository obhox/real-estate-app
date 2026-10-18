import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { generateUniqueReceiptRef } from "@/lib/ref";
import { getAppUrl, getReceiptAccessUrl, generateReceiptAccessToken } from "@/lib/app-url";
import { generateReceiptPdf } from "@/lib/receipts/generateReceiptPdf";
import { generateQrDataUrl } from "@/lib/receipts/qr";
import {
  applyConfirmationDbUnit,
  toUserFacingError,
  logServerError,
  PaymentAlreadyHandledError,
  OverScheduleError,
  TotalBalanceExceededError,
} from "@/lib/paymentConfirmation";
import { generateAndStoreReceiptPdf } from "@/lib/receiptDelivery";
import { formatDateDMY } from "@/lib/time";

// Confirm submits promptly; the receipt email sends synchronously (bounded
// Resend call, no queue). maxDuration covers DB work + PDF render + one send.
export const maxDuration = 60;



export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; paymentId: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, paymentId } = await ctx.params;
  const body = await request.json().catch(() => ({}));
  const verificationNotes = body?.verificationNotes ?? null;

  // Pre-transaction reads: snapshot for the PDF + receipt reference. The
  // transaction itself re-validates everything authoritatively.
  const preview = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { transaction: { include: { installments: true, paymentPlan: true } }, installment: true },
  });
  if (!preview || preview.transactionId !== id) {
    return NextResponse.json({ error: "Payment not found for this transaction." }, { status: 404 });
  }
  if (preview.status !== "PENDING_VERIFICATION") {
    return NextResponse.json(
      { error: "This payment is no longer pending. Refresh to see the latest state." },
      { status: 409 }
    );
  }

  let receiptRef: string;
  try {
    receiptRef = await generateUniqueReceiptRef();
  } catch (e) {
    logServerError("confirm payment: ref generation failed", e);
    return NextResponse.json({ error: "Couldn't confirm payment. Please try again." }, { status: 500 });
  }

  // Fail fast when APP_URL is missing in production (getAppUrl throws).
  try {
    getAppUrl();
  } catch (e) {
    // Actionable config message, no internals — safe to surface.
    logServerError("confirm payment: missing base URL", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Site URL is not configured." },
      { status: 500 }
    );
  }
  const accessToken = generateReceiptAccessToken();
  const receiptUrl = getReceiptAccessUrl(accessToken);

  // DB-ONLY transaction: claim payment → installment → totals → receipt row
  // (delivery PENDING). No PDF, no fs, no email in here.
  let confirmed;
  try {
    confirmed = await prisma.$transaction(
        async (tx) =>
        applyConfirmationDbUnit(tx, {
          paymentId,
          transactionId: id,
          confirmedById: session!.user.id,
          confirmedByName: session!.user.name ?? session!.user.email ?? "System",
          verificationNotes,
          receiptRef,
          receiptUrl,
          qrTargetUrl: receiptUrl,
          pdfPath: null,
          accessToken,
        }),
      { maxWait: 5000, timeout: 10000 }
    );
  } catch (e) {
    logServerError(`confirm payment ${paymentId}`, e);
    if (e instanceof PaymentAlreadyHandledError) {
      return NextResponse.json({ error: toUserFacingError(e, "confirm") }, { status: 409 });
    }
    if (e instanceof OverScheduleError) {
      return NextResponse.json({ error: toUserFacingError(e, "confirm") }, { status: 400 });
    }
    if (e instanceof TotalBalanceExceededError) {
      return NextResponse.json({ error: toUserFacingError(e, "confirm") }, { status: 400 });
    }
    return NextResponse.json({ error: toUserFacingError(e, "confirm") }, { status: 500 });
  }

  // ---- Post-commit side effects (recoverable; never roll back the above) ----
  const txn = preview.transaction;
  const issuedDateStr = formatDateDMY(confirmed.payment.paymentDate);
  const previouslyPaid = confirmed.newTotalPaid - confirmed.payment.amount;

  const qrDataUrl = await generateQrDataUrl(receiptUrl).catch((e) => {
    logServerError(`receipt ${receiptRef}: QR generation failed`, e);
    return undefined;
  });

  // Full receipt content: every confirmed payment with receipt refs and
  // running balances, the account reference line, and the settlement label.
  const { buildReceiptHistory, buildAccountRef, settlementCopy } = await import("@/lib/receipt-amounts");
  const [allConfirmed, allReceipts, bookingRow] = await Promise.all([
    prisma.payment.findMany({
      where: { transactionId: txn.id, status: "CONFIRMED" },
      select: { id: true, amount: true, paymentDate: true, paymentMethod: true },
    }),
    prisma.receipt.findMany({ where: { transactionId: txn.id }, select: { paymentId: true, ref: true } }),
    txn.bookingId
      ? prisma.inspectionBooking.findUnique({ where: { id: txn.bookingId }, select: { ref: true } })
      : null,
  ]);
  const refByPayment = new Map(allReceipts.map((r) => [r.paymentId as string, r.ref]));
  // The just-confirmed receipt exists in the DB now (created in the unit).
  refByPayment.set(confirmed.payment.id, receiptRef);
  const history = buildReceiptHistory(
    allConfirmed.map((p) => ({ id: p.id, date: p.paymentDate, method: p.paymentMethod ?? "Bank Transfer", amount: p.amount })),
    refByPayment,
    confirmed.payment.id,
    txn.totalPayable,
    formatDateDMY
  );

  // Generate the PDF once here and store the bytes on the receipt row.
  // Sends and downloads reuse these stored bytes; only an explicit
  // "Regenerate & resend" rebuilds them.
  const settlement = settlementCopy({
    balanceAfter: confirmed.newOutstanding,
    settledOn: confirmed.payment.paymentDate,
    scheduledEnd: txn.installments[txn.installments.length - 1]?.dueDate ?? null,
    formatDate: formatDateDMY,
  });
  const pdfOutcome = await generateAndStoreReceiptPdf({
    db: prisma,
    receiptId: confirmed.receiptId,
    ref: receiptRef,
    render: () =>
      generateReceiptPdf({
        ref: receiptRef,
        issuedDate: issuedDateStr,
        clientName: txn.customerName,
        clientAddress: `${txn.estate} · ${txn.unitType ?? "Plot"} · ${txn.plotCode ?? txn.ref}`,
        clientPhone: txn.customerPhone ?? "",
        clientEmail: txn.customerEmail,
        estateName: txn.estate,
        unitType: txn.unitType ?? "Plot",
        plotCode: txn.plotCode ?? txn.ref,
        amountPaid: confirmed.payment.amount,
        soldPrice: txn.baseAmount,
        discount: 0,
        payments: [
          {
            date: issuedDateStr,
            method: confirmed.payment.paymentMethod ?? "Bank Transfer",
            amount: confirmed.payment.amount,
          },
        ],
        history: history.map((h) => ({ date: h.date, method: h.method, amount: h.amount, receiptRef: h.receiptRef, runningBalance: h.runningBalance, isCurrent: h.isCurrent })),
        accountRef: buildAccountRef(txn.ref, bookingRow?.ref ?? null),
        label: settlement.headline,
        settlementNote: settlement.note,
        paymentDate: issuedDateStr,
        paymentMethodLabel: confirmed.payment.paymentMethod ?? "Bank Transfer",
        bankReference: preview.bankReference ?? null,
        receiptUrl,
        qrDataUrl,
        unitPrice: txn.unitPrice,
        plotQuantity: txn.plotQuantity,
        paymentPlanName: txn.paymentPlan?.name,
        interestAmount: txn.interestAmount,
        totalPayable: txn.totalPayable,
        previouslyPaid,
        totalPaidAfter: confirmed.newTotalPaid,
        outstandingBalance: confirmed.newOutstanding,
        transactionRef: txn.ref,
      }),
  });

  if (!pdfOutcome.ok) {
    return NextResponse.json({
      receipt: { id: confirmed.receiptId, ref: receiptRef },
      email: { sent: false as const, error: pdfOutcome.error },
      warning: "Payment confirmed, but the receipt PDF failed. Retry from the receipt page.",
    });
  }

  // Direct Resend send (no queue). Stable key per receipt: a retried confirm
  // request can never double-send (the atomic claim 409s before this point),
  // and a timeout retry replays the identical body under the same key.
  const { sendReceiptEmail } = await import("@/lib/receipts/emailReceipt");
  const { persistReceiptEmailSent } = await import("@/lib/receiptDelivery");
  const plotsSummary =
    txn.plotQuantity != null
      ? txn.sqm
        ? `Plots: ${txn.plotQuantity} × ${txn.sqm}sqm`
        : `Plots: ${txn.plotQuantity}`
      : null;
  let email: { sent: boolean; error: string | null; resendEmailId?: string | null };
  try {
    const sent = await sendReceiptEmail({
      to: txn.customerEmail,
      clientName: txn.customerName,
      ref: receiptRef,
      receiptUrl,
      pdfBuffer: pdfOutcome.bytes!,
      idempotencyKey: `receipt:${confirmed.receiptId}`,
      plotsSummary,
      isFinalPayment: confirmed.isPaidInFull,
      accountRef: buildAccountRef(txn.ref, bookingRow?.ref ?? null),
    });
    email = { sent: sent.sent, error: sent.error, resendEmailId: sent.providerMessageId ?? null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Email failed";
    logServerError(`receipt ${receiptRef}: email send threw`, e);
    email = { sent: false, error: msg };
  }
  if (email.sent) {
    await persistReceiptEmailSent({
      db: prisma,
      receiptId: confirmed.receiptId,
      ref: receiptRef,
      resendEmailId: email.resendEmailId ?? null,
    });
    try {
      await prisma.auditEvent.create({
        data: {
          actorId: session!.user.id,
          actorName: session!.user.name ?? session!.user.email ?? "Unknown",
          action: "receipt.send",
          entityType: "receipt",
          entityId: confirmed.receiptId,
          before: { emailSent: false },
          after: { sent: true, to: txn.customerEmail, resendEmailId: email.resendEmailId ?? null },
        },
      });
    } catch (e) {
      logServerError(`receipt ${receiptRef}: failed to log send audit`, e);
    }
  }

  return NextResponse.json({
    receipt: { id: confirmed.receiptId, ref: receiptRef },
    email,
    ...(email.sent ? {} : { warning: "Payment confirmed and receipt generated, but the email did not send. Use Resend on the receipt page." }),
  });
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string; paymentId: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, paymentId } = await ctx.params;
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { receipt: true, installment: true, transaction: true } });
  if (!payment || payment.transactionId !== id) return NextResponse.json({ error: "Payment not found" }, { status: 404 });
  return NextResponse.json({ payment });
}
