// Regenerates every receipt PDF with the correct tokenized URL and QR
// ({APP_URL}/r/{accessToken}). Keeps the same receipt numbers (refs).
//
// Usage: npx tsx scripts/regenerate-receipts.ts [--apply] [--resend]
// Default is --dry-run. --apply rewrites PDFs + receipt URLs on disk and DB.
// --resend re-sends each receipt to its recipient with a short note that the
// previous link was incorrect. NEVER resend unless --resend is passed.
// (Option 1: no real clients were emailed — do not pass --resend.)
// Run AFTER scripts/migrate-receipt-storage.ts --apply.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { generateReceiptAccessToken, getReceiptAccessUrl } from "../src/lib/app-url.js";
import { receiptPdfPath, writeReceiptPdf } from "../src/lib/receipt-storage.js";
import { generateReceiptPdf } from "../src/lib/receipts/generateReceiptPdf.js";
import { generateQrDataUrl } from "../src/lib/receipts/qr.js";
import { formatDateDMY } from "../src/lib/time.js";
import { sendReceiptEmail } from "../src/lib/receipts/emailReceipt.js";

const APPLY = process.argv.includes("--apply");
const RESEND = process.argv.includes("--resend");



async function main() {
  if (RESEND && !APPLY) {
    console.error("--resend requires --apply. Nothing done.");
    process.exit(1);
  }
  const receipts = await prisma.receipt.findMany({
    orderBy: { ref: "asc" },
    include: {
      payment: { include: { installment: true } },
      transaction: { include: { paymentPlan: true, payments: { where: { status: "CONFIRMED" }, orderBy: { paymentDate: "asc" } } } },
    },
  });
  console.log(`[dry-run=${!APPLY} resend=${RESEND}] ${receipts.length} receipts`);
  for (const r of receipts) {
    if (!r.payment || !r.transaction) {
      console.log(`  SKIP ${r.ref}: no payment/transaction link (manual legacy row)`);
      continue;
    }
    const token = r.accessToken ?? generateReceiptAccessToken();
    const receiptUrl = getReceiptAccessUrl(token);
    const pdfPath = receiptPdfPath(r.ref);
    const txn = r.transaction;
    const previouslyPaid = txn.payments
      .filter((p) => p.paymentDate < r.payment!.paymentDate || (p.paymentDate.getTime() === r.payment!.paymentDate.getTime() && p.id < r.paymentId))
      .reduce((s, p) => s + p.amount, 0);
    console.log(`  REGEN ${r.ref}: url=${receiptUrl} pdf=${pdfPath} previouslyPaid=₦${previouslyPaid.toLocaleString("en-NG")}${RESEND ? ` resend→${r.recipientEmail}` : ""}`);
    if (!APPLY) continue;

    const qrDataUrl = await generateQrDataUrl(receiptUrl).catch(() => undefined);
    const issuedDateStr = formatDateDMY(r.payment.paymentDate);
    const inst = r.payment.installment;
    const installmentLabel = !inst || inst.type === "INITIAL" ? "Initial payment" : `Month ${inst.installmentNumber} payment`;
    const paymentDescription = `${installmentLabel} — ${txn.estate}${txn.unitType ? `, ${txn.unitType}` : ""}${txn.plotCode ? ` (${txn.plotCode})` : ""}`;
    const { buildReceiptHistory, buildAccountRef, settlementLabel } = await import("../src/lib/receipt-amounts.js");
    const allReceipts = await prisma.receipt.findMany({ where: { transactionId: txn.id }, select: { paymentId: true, ref: true } });
    const refByPayment = new Map(allReceipts.map((x) => [x.paymentId as string, x.ref]));
    refByPayment.set(r.payment.id, r.ref);
    const bookingRow = txn.bookingId
      ? await prisma.inspectionBooking.findUnique({ where: { id: txn.bookingId }, select: { ref: true } })
      : null;
    const history = buildReceiptHistory(
      txn.payments.map((p) => ({ id: p.id, date: p.paymentDate, method: p.paymentMethod ?? "Bank Transfer", amount: p.amount })),
      refByPayment,
      r.payment.id,
      txn.totalPayable,
      formatDateDMY
    );
    const balanceAfter = txn.totalPayable - previouslyPaid - r.payment.amount;
    const pdfBuffer = generateReceiptPdf({
      ref: r.ref,
      issuedDate: issuedDateStr,
      clientName: txn.customerName,
      clientAddress: `${txn.estate} · ${txn.unitType ?? "Plot"} · ${txn.plotCode ?? txn.ref}`,
      clientPhone: txn.customerPhone ?? "",
      clientEmail: txn.customerEmail,
      estateName: txn.estate,
      unitType: txn.unitType ?? "Plot",
      plotCode: txn.plotCode ?? txn.ref,
      amountPaid: r.payment.amount,
      soldPrice: txn.baseAmount,
      discount: 0,
      payments: [{ date: issuedDateStr, method: r.payment.paymentMethod ?? "Bank Transfer", amount: r.payment.amount }],
      history: history.map((h) => ({ date: h.date, method: h.method, amount: h.amount, receiptRef: h.receiptRef, runningBalance: h.runningBalance, isCurrent: h.isCurrent })),
      accountRef: buildAccountRef(txn.ref, bookingRow?.ref ?? null),
      label: settlementLabel(balanceAfter),
      paymentDate: issuedDateStr,
      paymentMethodLabel: r.payment.paymentMethod ?? "Bank Transfer",
      bankReference: r.payment.bankReference ?? null,
      receiptUrl,
      qrDataUrl,
      unitPrice: txn.unitPrice,
      plotQuantity: txn.plotQuantity,
      paymentPlanName: txn.paymentPlan?.name,
      interestAmount: txn.interestAmount,
      totalPayable: txn.totalPayable,
      previouslyPaid,
      totalPaidAfter: previouslyPaid + r.payment.amount,
      outstandingBalance: txn.totalPayable - previouslyPaid - r.payment.amount,
      transactionRef: txn.ref,
    });
    await writeReceiptPdf(pdfPath, pdfBuffer);
    await prisma.receipt.update({
      where: { id: r.id },
      data: {
        accessToken: token,
        receiptUrl,
        qrTargetUrl: receiptUrl,
        pdfPath,
        pdfStatus: "GENERATED",
        pdfData: new Uint8Array(pdfBuffer),
        paymentDescription,
      },
    });
    if (RESEND) {
      const result = await sendReceiptEmail({
        to: r.recipientEmail,
        clientName: txn.customerName,
        ref: r.ref,
        receiptUrl,
        pdfBuffer,
        idempotencyKey: `regen:${r.id}:${Date.now()}`,
      });
      if (result.sent) {
        await prisma.receipt.update({
          where: { id: r.id },
          data: { resendEmailId: result.providerMessageId ?? null, sentAt: new Date() },
        });
      }
      console.log(`    resent: sent=${result.sent}`);
    }
  }
  if (!APPLY) console.log("Dry run complete — re-run with --apply to write changes.");
  else console.log("Applied: PDFs regenerated with tokenized URLs.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
