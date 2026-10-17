import { prisma } from "@/lib/prisma";
import { generateReceiptPdf } from "@/lib/receipts/generateReceiptPdf";
import { generateQrDataUrl } from "@/lib/receipts/qr";
import { getReceiptAccessUrl } from "@/lib/app-url";
import { buildReceiptHistory, buildAccountRef, settlementCopy, appliedToLabel } from "@/lib/receipt-amounts";
import { getAllocationLabelParts } from "@/lib/finance/ledger";
import { formatDateDMY } from "@/lib/time";



// Single source of truth for rebuilding a receipt PDF from the stored
// snapshot + linked payment/transaction. Used when the filesystem cache
// (ephemeral on serverless — /tmp, never shared between invocations) misses:
// email outbox regen, admin PDF download, and client token PDF download.
//
// Never throws for QR issues (QR is best-effort); throws only when the
// receipt row (or its payment/transaction link) is missing or rendering fails.
export async function renderReceiptPdfBuffer(receiptId: string, opts?: { force?: boolean }): Promise<Buffer> {
  const receipt = await prisma.receipt.findUnique({
    where: { id: receiptId },
    include: {
      payment: { include: { installment: { select: { type: true, installmentNumber: true } } } },
      transaction: {
        select: {
          ref: true,
          totalPayable: true,
          unitPrice: true,
          plotQuantity: true,
          interestAmount: true,
          paymentPlan: { select: { name: true } },
          booking: { select: { ref: true } },
          payments: {
            where: { status: "CONFIRMED" },
            select: { id: true, amount: true, paymentDate: true, paymentMethod: true },
          },
          receipts: { select: { paymentId: true, ref: true } },
        },
      },
    },
  });
  if (!receipt) throw new Error("Receipt no longer exists");
  if (!receipt.payment) throw new Error("Receipt has no payment link");

  // Stored bytes win: the PDF was rendered once at confirmation and every
  // send/download reuses those exact bytes (resends never regenerate).
  // Only rows predating stored bytes fall through to render-on-demand, and
  // an explicit force (Regenerate & resend) always rebuilds from the snapshot.
  if (receipt.pdfData && !opts?.force) return Buffer.from(receipt.pdfData);

  // Canonical QR target: derived from this row's own accessToken, never from
  // the stored qrTargetUrl (which can predate an APP_URL change and point at
  // a stale dev origin or another deployment). One receipt → one token → one URL, so
  // a QR can never open a different document. Pre-migration rows without a
  // token fall back to the stored URL so they still render (verify script
  // flags them as BROKEN for backfill).
  const canonicalUrl = receipt.accessToken
    ? getReceiptAccessUrl(receipt.accessToken)
    : (receipt.qrTargetUrl || receipt.receiptUrl);
  if (!canonicalUrl) throw new Error("Receipt has no QR target URL");
  const qr = await generateQrDataUrl(canonicalUrl).catch(() => undefined);
  const totalPayable = receipt.transaction?.totalPayable ?? receipt.amountBeforeDiscount;
  // Replacement linkage: this receipt supersedes the original's receipt.
  let replacesRef: string | null = null;
  const correctsId = (receipt.payment as { correctsPaymentId?: string | null } | null)?.correctsPaymentId ?? null;
  if (correctsId) {
    const original = await prisma.receipt.findFirst({ where: { paymentId: correctsId }, select: { ref: true } });
    replacesRef = original?.ref ?? null;
  }
  // Voided payments leave CONFIRMED scope but their receipt stays renderable:
  // include the receipt's own payment so history still stops at this payment.
  const confirmedList = [...(receipt.transaction?.payments ?? [])];
  if (receipt.payment && !confirmedList.some((p) => p.id === receipt.payment!.id)) {
    confirmedList.push({
      id: receipt.payment.id,
      paymentDate: receipt.payment.paymentDate,
      paymentMethod: receipt.payment.paymentMethod,
      amount: receipt.payment.amount,
    });
  }
  const history = buildReceiptHistory(
    confirmedList.map((p) => ({
      id: p.id,
      date: p.paymentDate,
      method: p.paymentMethod ?? "Bank Transfer",
      amount: p.amount,
    })),
    new Map((receipt.transaction?.receipts ?? []).map((r) => [r.paymentId as string, r.ref])),
    receipt.paymentId,
    totalPayable,
    formatDateDMY
  );
  const previouslyPaid = history
    .filter((h) => !h.isCurrent)
    .reduce((s, h) => s + h.amount, 0);
  const balanceAfter = totalPayable - previouslyPaid - receipt.finalAmount;
  const settlement = settlementCopy({
    balanceAfter,
    settledOn: receipt.payment?.paymentDate ?? receipt.issuedAt,
    formatDate: formatDateDMY,
  });
  // Allocation-derived label (see receipt-amounts); pre-backfill rows without
  // allocation rows keep the old installment-link label.
  const allocParts = await getAllocationLabelParts(prisma, receipt.payment.id).catch(() => []);

  return generateReceiptPdf({
    ref: receipt.ref,
    issuedDate: formatDateDMY(receipt.issuedAt),
    clientName: receipt.customerName,
    clientAddress: receipt.property,
    clientPhone: receipt.customerPhone ?? "",
    clientEmail: receipt.customerEmail,
    estateName: receipt.estate ?? "",
    unitType: receipt.unitType ?? "",
    plotCode: receipt.plotCode ?? receipt.ref,
    amountPaid: receipt.finalAmount,
    soldPrice: receipt.amountBeforeDiscount,
    discount: receipt.discount || undefined,
    payments: history.map((h) => ({ date: h.date, method: h.method, amount: h.amount })),
    history: history.map((h) => ({ date: h.date, method: h.method, amount: h.amount, receiptRef: h.receiptRef, runningBalance: h.runningBalance, isCurrent: h.isCurrent })),
    accountRef: receipt.transaction ? buildAccountRef(receipt.transaction.ref, receipt.transaction.booking?.ref ?? null) : undefined,
    replacesRef,
    label: settlement.headline,
    settlementNote: settlement.note,
    paymentDate: formatDateDMY(receipt.payment?.paymentDate ?? receipt.issuedAt),
    paymentMethodLabel: receipt.paymentMethod ?? receipt.payment?.paymentMethod ?? "Bank Transfer",
    bankReference: receipt.payment?.bankReference ?? null,
    receiptUrl: canonicalUrl,
    qrDataUrl: qr,
    unitPrice: receipt.unitPrice ?? receipt.transaction?.unitPrice ?? undefined,
    plotQuantity: receipt.plotQuantity ?? receipt.transaction?.plotQuantity ?? undefined,
    paymentPlanName: receipt.paymentPlanName ?? receipt.transaction?.paymentPlan?.name ?? undefined,
    interestAmount: receipt.transaction?.interestAmount ?? undefined,
    totalPayable,
    previouslyPaid,
    totalPaidAfter: previouslyPaid + receipt.finalAmount,
    outstandingBalance: balanceAfter,
    installmentLabel: allocParts.length > 0
      ? appliedToLabel(allocParts)
      : receipt.payment?.installment
        ? receipt.payment.installment.type === "INITIAL"
          ? "Initial payment"
          : `Month ${receipt.payment.installment.installmentNumber} payment`
        : undefined,
  });
}
