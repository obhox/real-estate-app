import { prisma } from "@/lib/prisma";
import { generateUniquePaymentRef, generateUniqueReceiptRef } from "@/lib/ref";
import { getAppUrl, getReceiptAccessUrl, generateReceiptAccessToken } from "@/lib/app-url";
import { generateReceiptPdf } from "@/lib/receipts/generateReceiptPdf";
import { generateQrDataUrl } from "@/lib/receipts/qr";
import { applyConfirmationDbUnit, logServerError, TotalBalanceExceededError } from "@/lib/paymentConfirmation";
import { generateAndStoreReceiptPdf } from "@/lib/receiptDelivery";
import { formatDateDMY } from "@/lib/time";



// Single-step record-and-confirm used by transaction creation with an
// initial payment. Same guarantees as the two-step flow: the database
// transaction contains DB work only; PDF/email happen post-commit and can
// never roll back the payment. Receipts are strictly 1:1 with payments.
export async function recordPaymentAndGenerateReceipt(params: {
  transactionId: string;
  installmentId?: string | null;
  amount: number;
  paymentDate: Date;
  paymentMethod?: string | null;
  notes?: string | null;
  recordedById?: string | null;
  recordedByName?: string | null;
}) {
  if (!Number.isInteger(params.amount) || params.amount <= 0) throw new Error("Enter a whole-naira amount");

  // Pre-transaction validation reads (authoritative re-checks run inside).
  const transaction = await prisma.transaction.findUnique({
    where: { id: params.transactionId },
    include: { installments: { orderBy: { installmentNumber: "asc" } }, paymentPlan: true },
  });
  if (!transaction) throw new Error("Transaction not found");
  if (transaction.status === "CANCELLED") throw new Error("Transaction is cancelled");
  // The ONLY gate (same rule as the confirm step, which re-checks atomically):
  // the cumulative total including this payment must not exceed the account's
  // total balance. Any amount at or below the outstanding balance is accepted
  // — no per-installment amount, order, or due-date checks.
  if (params.amount > transaction.outstandingBalance) {
    throw new TotalBalanceExceededError(transaction.totalPaid, params.amount, transaction.totalPayable);
  }

  // No installment shortlist: the confirmation waterfall allocates from the
  // oldest unpaid capacity, so a missing or fully-paid target never blocks a
  // payment that fits the total balance (null = auto-resolve at confirm).
  const installment =
    params.installmentId != null
      ? (transaction.installments.find((i) => i.id === params.installmentId) ?? null)
      : null;

  const receiptRef = await generateUniqueReceiptRef();
  const paymentRef = await generateUniquePaymentRef();
  getAppUrl(); // throws in production when APP_URL is missing — fail before any write
  const accessToken = generateReceiptAccessToken();
  const receiptUrl = getReceiptAccessUrl(accessToken);

  // DB-ONLY transaction: payment row → confirm claim → installment → totals → receipt row.
  const confirmed = await prisma.$transaction(
    async (tx) => {
      const payment = await tx.payment.create({
        data: {
          transactionId: transaction.id,
          installmentId: installment?.id ?? null,
          paymentReference: paymentRef,
          amount: params.amount,
          paymentDate: params.paymentDate,
          paymentMethod: params.paymentMethod,
          notes: params.notes,
          recordedById: params.recordedById,
          status: "PENDING_VERIFICATION",
        },
      });
      return applyConfirmationDbUnit(tx, {
        paymentId: payment.id,
        transactionId: transaction.id,
        confirmedById: params.recordedById,
        receiptRef,
        receiptUrl,
        qrTargetUrl: receiptUrl,
        pdfPath: null,
        accessToken,
      });
    },
    { maxWait: 5000, timeout: 10000 }
  );

  // ---- Post-commit side effects (recoverable) ----
  const issuedDateStr = formatDateDMY(confirmed.payment.paymentDate);
  const previouslyPaid = confirmed.newTotalPaid - confirmed.payment.amount;

  const qrDataUrl = await generateQrDataUrl(receiptUrl).catch((e) => {
    logServerError(`receipt ${receiptRef}: QR generation failed`, e);
    return undefined;
  });

  const pdfOutcome = await generateAndStoreReceiptPdf({
    db: prisma,
    receiptId: confirmed.receiptId,
    ref: receiptRef,
    render: async () => {
      const { buildReceiptHistory, buildAccountRef, settlementCopy, appliedToLabel } = await import("@/lib/receipt-amounts");
      const { getAllocationLabelParts } = await import("@/lib/finance/ledger");
      const fullTxn = await prisma.transaction.findUnique({
        where: { id: transaction.id },
        select: { bookingId: true },
      });
      const [allConfirmed, allReceipts, bookingRow] = await Promise.all([
        prisma.payment.findMany({
          where: { transactionId: transaction.id, status: "CONFIRMED" },
          select: { id: true, amount: true, paymentDate: true, paymentMethod: true },
        }),
        prisma.receipt.findMany({ where: { transactionId: transaction.id }, select: { paymentId: true, ref: true } }),
        fullTxn?.bookingId
          ? prisma.inspectionBooking.findUnique({ where: { id: fullTxn.bookingId }, select: { ref: true } })
          : null,
      ]);
      const refByPayment = new Map(allReceipts.map((r) => [r.paymentId as string, r.ref]));
      refByPayment.set(confirmed.payment.id, receiptRef);
      const history = buildReceiptHistory(
        allConfirmed.map((p) => ({ id: p.id, date: p.paymentDate, method: p.paymentMethod ?? "Bank Transfer", amount: p.amount })),
        refByPayment,
        confirmed.payment.id,
        transaction.totalPayable,
        formatDateDMY
      );
      const saved = await prisma.payment.findUnique({ where: { id: confirmed.payment.id }, select: { bankReference: true } });
      const allocParts = await getAllocationLabelParts(prisma, confirmed.payment.id).catch(() => []);
      const installmentLabel =
        allocParts.length > 0
          ? appliedToLabel(allocParts)
          : confirmed.installment
            ? confirmed.installment.type === "INITIAL"
              ? "Initial payment"
              : `Month ${confirmed.installment.installmentNumber} payment`
            : undefined;
      const settlement = settlementCopy({
        balanceAfter: confirmed.newOutstanding,
        settledOn: confirmed.payment.paymentDate,
        scheduledEnd: transaction.installments[transaction.installments.length - 1]?.dueDate ?? null,
        formatDate: formatDateDMY,
      });
      return generateReceiptPdf({
        ref: receiptRef,
        issuedDate: issuedDateStr,
        clientName: transaction.customerName,
        clientAddress: `${transaction.estate} · ${transaction.unitType ?? "Plot"} · ${transaction.plotCode ?? transaction.ref}`,
        clientPhone: transaction.customerPhone ?? "",
        clientEmail: transaction.customerEmail,
        estateName: transaction.estate,
        unitType: transaction.unitType ?? "Plot",
        plotCode: transaction.plotCode ?? transaction.ref,
        amountPaid: params.amount,
        soldPrice: transaction.baseAmount,
        discount: 0,
        payments: [{ date: issuedDateStr, method: params.paymentMethod ?? "Bank Transfer", amount: params.amount }],
        history: history.map((h) => ({ date: h.date, method: h.method, amount: h.amount, receiptRef: h.receiptRef, runningBalance: h.runningBalance, isCurrent: h.isCurrent })),
        accountRef: buildAccountRef(transaction.ref, bookingRow?.ref ?? null),
        label: settlement.headline,
        settlementNote: settlement.note,
        paymentDate: issuedDateStr,
        paymentMethodLabel: params.paymentMethod ?? "Bank Transfer",
        bankReference: saved?.bankReference ?? null,
        receiptUrl,
        qrDataUrl,
        unitPrice: transaction.unitPrice,
        plotQuantity: transaction.plotQuantity,
        paymentPlanName: transaction.paymentPlan?.name,
        interestAmount: transaction.interestAmount,
        totalPayable: transaction.totalPayable,
        previouslyPaid,
        totalPaidAfter: confirmed.newTotalPaid,
        outstandingBalance: confirmed.newOutstanding,
        transactionRef: transaction.ref,
        installmentLabel,
      });
    },
  });

  if (!pdfOutcome.ok) {
    const receipt = await prisma.receipt.findUnique({ where: { id: confirmed.receiptId }, omit: { pdfData: true } });
    const payment = await prisma.payment.findUnique({ where: { id: confirmed.payment.id } });
    return { payment, receipt, email: { sent: false as const, error: pdfOutcome.error } };
  }

  // Direct Resend send (no queue). Stable key per receipt — safe replay.
  const { sendReceiptEmail } = await import("@/lib/receipts/emailReceipt");
  const { persistReceiptEmailSent } = await import("@/lib/receiptDelivery");
  const { buildAccountRef } = await import("@/lib/receipt-amounts");
  const bookingRefRow = await prisma.transaction.findUnique({
    where: { id: transaction.id },
    select: { booking: { select: { ref: true } } },
  });
  let email: { sent: boolean; error: string | null; resendEmailId?: string | null };
  try {
    const sent = await sendReceiptEmail({
      to: transaction.customerEmail,
      clientName: transaction.customerName,
      ref: receiptRef,
      receiptUrl,
      pdfBuffer: pdfOutcome.bytes!,
      idempotencyKey: `receipt:${confirmed.receiptId}`,
      isFinalPayment: confirmed.isPaidInFull,
      accountRef: buildAccountRef(transaction.ref, bookingRefRow?.booking?.ref ?? null),
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
  }

  const receipt = await prisma.receipt.findUnique({ where: { id: confirmed.receiptId }, omit: { pdfData: true } });
  const payment = await prisma.payment.findUnique({ where: { id: confirmed.payment.id } });
  return { payment, receipt, email };
}
