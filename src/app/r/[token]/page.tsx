import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { formatNaira } from "@/lib/currency";
import { formatDisplayName } from "@/lib/formatName";
import { receiptAmountsRows, buildReceiptHistory, buildAccountRef, settlementCopy } from "@/lib/receipt-amounts";
import { isTokenUsable } from "@/lib/receipt-access";
import { formatDateDMY } from "@/lib/time";

export const dynamic = "force-dynamic";

export const viewport = {
  width: "device-width",
  initialScale: 1,
};



// Client-facing receipt page. No login — the unguessable access token in the
// URL is the authorization. Revoked or unknown tokens render notFound.
export default async function ClientReceiptPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const receipt = await prisma.receipt.findUnique({
    where: { accessToken: token },
    omit: { pdfData: true },
    include: {
      payment: { include: { installment: { select: { type: true, installmentNumber: true } } } },
      replacedBy: { select: { ref: true, accessToken: true } },
      transaction: {
        select: {
          ref: true,
          totalPayable: true,
          unitPrice: true,
          plotQuantity: true,
          interestAmount: true,
          booking: { select: { ref: true } },
          payments: { where: { status: "CONFIRMED" }, select: { id: true, amount: true, paymentDate: true, paymentMethod: true } },
          receipts: { select: { paymentId: true, ref: true } },
        },
      },
    },
  });
  if (!isTokenUsable(receipt)) {
    notFound();
  }

  // A receipt shows only what was paid — no schedule, no per-installment
  // "applied to" line (that lives on the client statement).
  const clientPayment = receipt.payment;
  const confirmedList = [...(receipt.transaction?.payments ?? [])];
  if (clientPayment && !confirmedList.some((p) => p.id === clientPayment.id)) {
    confirmedList.push({ id: clientPayment.id, amount: clientPayment.amount, paymentDate: clientPayment.paymentDate, paymentMethod: clientPayment.paymentMethod });
  }
  const totalPrice = receipt.transaction?.totalPayable ?? receipt.amountBeforeDiscount;
  const history = buildReceiptHistory(
    confirmedList.map((p) => ({ id: p.id, date: p.paymentDate, method: p.paymentMethod ?? "Bank Transfer", amount: p.amount })),
    new Map((receipt.transaction?.receipts ?? []).map((r) => [r.paymentId as string, r.ref])),
    receipt.paymentId,
    totalPrice,
    formatDateDMY
  );
  const previouslyPaid = history.filter((h) => !h.isCurrent).reduce((s, h) => s + h.amount, 0);
  const paidToDate = previouslyPaid + receipt.finalAmount;
  const balanceAfter = totalPrice - paidToDate;
  const settlement = settlementCopy({
    balanceAfter,
    settledOn: receipt.payment?.paymentDate ?? receipt.issuedAt,
    formatDate: formatDateDMY,
  });
  const label = settlement.headline;
  const accountRef = receipt.transaction ? buildAccountRef(receipt.transaction.ref, receipt.transaction.booking?.ref ?? null) : null;
  const plotQty = receipt.plotQuantity ?? receipt.transaction?.plotQuantity ?? null;

  return (
    <div className="min-h-screen bg-[#F7F2E7] py-6 sm:py-8 px-3 sm:px-6">
      <div className="w-full max-w-[800px] mx-auto bg-white border border-[#E4DCC7] rounded-xl overflow-hidden shadow-[0_8px_24px_rgba(22,40,31,0.08)]">
        <div className="px-4 sm:px-8 pt-6 sm:pt-8 pb-6 border-b border-[#E4DCC7] flex flex-col sm:flex-row sm:justify-between gap-4 sm:gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/belgrove-icon.png" alt="Belgrove Homes" width={40} height={32} className="shrink-0" />
            <div className="min-w-0">
              <div className="fraunces text-[13px] font-bold tracking-wide text-[#16281F] break-words">BELGROVE HOMES AND PROPERTIES LIMITED</div>
              <div className="mono text-[11px] text-[#6B6656] mt-1 break-words">Suite 25, Lebrex Plaza, 47 Ajose Adeogun St, Utako, Abuja 900108, Federal Capital Territory</div>
            </div>
          </div>
          <div className="mono text-[11px] text-[#16281F] text-left sm:text-right leading-[1.6] shrink-0 break-words">
            <div>www.belgrovehomes.com</div>
            <div className="break-all">info@belgrovehomes.com</div>
            <div>+234 8103760063</div>
          </div>
        </div>

        <div className="px-4 sm:px-8 py-6">
          {receipt.voidedAt && (
            <div className="mb-6 rounded-xl border-2 border-red-700 bg-red-50 px-4 py-4">
              <div className="fraunces text-[16px] font-bold text-red-800">VOID — this receipt was corrected and is no longer valid</div>
              <p className="public text-[13px] text-red-900 mt-1">
                The figures on this receipt are superseded. Please use the replacement receipt instead.
              </p>
              {receipt.replacedBy?.accessToken && (
                <a href={`/r/${receipt.replacedBy.accessToken}`} className="mt-2 inline-block mono text-[12px] bg-red-800 text-white px-4 py-2 rounded-full">
                  Open replacement {receipt.replacedBy.ref} ↗
                </a>
              )}
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-start pt-2">
            <div>
              <h1 className="fraunces text-[24px] sm:text-[28px] font-bold text-[#16281F]">RECEIPT</h1>
              <div className="mono text-[11px] tracking-[0.12em] text-[#8B6B4E] mt-1">{label}</div>
              {settlement.note && <div className="public text-[12px] text-[#16281F] mt-2">{settlement.note}</div>}
            </div>
            <div className="text-left sm:text-right mono text-[11px] text-[#6B6656] break-words">
              <div className="break-all">RECEIPT: {receipt.ref}</div>
              <div>ISSUED DATE: {formatDateDMY(receipt.issuedAt)}</div>
              {accountRef && <div className="break-all">ACCOUNT: {accountRef}</div>}
            </div>
          </div>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-[1.4fr_0.9fr] gap-4 sm:gap-6">
            <div className="min-w-0">
              <div className="mono text-[10px] tracking-[0.12em] uppercase text-[#8B6B4E]">Issued to</div>
              <div className="public text-[14px] font-semibold text-[#16281F] mt-2 break-words">{formatDisplayName(receipt.customerName)}</div>
              {receipt.customerPhone && <div className="mono text-[12px] text-[#6B6656] mt-2 break-words">{receipt.customerPhone}</div>}
              <div className="mono text-[12px] text-[#6B6656] break-all">{receipt.customerEmail}</div>
            </div>
            <div className="bg-[#C79A46] rounded-lg p-4 text-white">
              {receiptAmountsRows({
                thisPayment: receipt.finalAmount,
                totalPrice,
                interestAmount: receipt.transaction?.interestAmount ?? null,
                paidToDate,
                balanceRemaining: balanceAfter,
                discount: receipt.discount,
              }).map((row, i) => (
                <div key={row.key} className={`mono text-[11px] opacity-90 ${i === 0 ? "" : "mt-2"}`}>
                  {i === 0 && <div className="mono text-[10px] tracking-[0.12em] uppercase opacity-90">{row.label}</div>}
                  {i === 0 ? (
                    <div className="fraunces text-[20px] font-bold mt-1">{formatNaira(row.value as number)}</div>
                  ) : (
                    <span>{row.label.toUpperCase()}: {typeof row.value === "number" ? formatNaira(row.value) : row.value}</span>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="mono text-[11px] font-bold text-[#16281F] mt-6 break-words">{receipt.property}</div>
          <div className="mono text-[11px] text-[#6B6656] mt-1">
            {clientPayment?.paymentMethod ?? receipt.paymentMethod ?? "Bank Transfer"}
            {clientPayment?.bankReference ? ` · Bank ref: ${clientPayment.bankReference}` : ""}
            {clientPayment ? ` · ${formatDateDMY(clientPayment.paymentDate)}` : ""}
          </div>
          {plotQty != null && (
            <div className="mono text-[11px] text-[#6B6656] mt-1">
              Plots: {receipt.sqm ? `${plotQty} × ${receipt.sqm}sqm` : `${plotQty} plot${plotQty === 1 ? "" : "s"}`}
            </div>
          )}

          <div className="mt-4 border border-[#E4DCC7] rounded-lg overflow-x-auto">
            <div className="min-w-[640px]">
              <div className="grid grid-cols-[36px_1fr_1fr_1fr_1fr_1fr] bg-[#16281F] text-[#D4B368] mono text-[11px] font-medium">
                <div className="px-3 py-2">#</div>
                <div className="px-3 py-2">Payment Date</div>
                <div className="px-3 py-2">Method</div>
                <div className="px-3 py-2">Receipt</div>
                <div className="px-3 py-2 text-right">Amount (₦)</div>
                <div className="px-3 py-2 text-right">Balance (₦)</div>
              </div>
              {history.map((h) => (
                <div key={h.index} className={`grid grid-cols-[36px_1fr_1fr_1fr_1fr_1fr] mono text-[12px] ${h.index % 2 === 0 ? "bg-[#F7F2E7]" : "bg-white"} border-t border-[#E4DCC7] ${h.isCurrent ? "font-bold" : ""}`}>
                  <div className="px-3 py-2">{h.index}</div>
                  <div className="px-3 py-2 break-words">{h.date}</div>
                  <div className="px-3 py-2 break-words">{h.method}</div>
                  <div className="px-3 py-2 break-words">{h.receiptRef ?? "-"}</div>
                  <div className="px-3 py-2 text-right break-words">{formatNaira(h.amount)}</div>
                  <div className="px-3 py-2 text-right break-words">{formatNaira(h.runningBalance)}</div>
                </div>
              ))}
              <div className="grid grid-cols-[36px_1fr_1fr_1fr_1fr_1fr] bg-[#16281F] text-[#D4B368] mono text-[12px] font-bold border-t border-[#E4DCC7]">
                <div className="px-3 py-2 col-span-4">Total paid to date</div>
                <div className="px-3 py-2 text-right break-words col-span-2">{formatNaira(paidToDate)}</div>
              </div>
            </div>
          </div>

          <div className="mono text-[11px] text-[#6B6656] mt-4">Amount in words:</div>
          <div className="fraunces text-[13px] font-semibold text-[#16281F] break-words">{receipt.amountInWords}</div>

          <p className="public text-[11px] leading-[1.5] text-[#8B6B4E] mt-4 border-t border-[#E4DCC7] pt-4">
            This receipt acknowledges payment as received and reconciled by Belgrove Homes accounts. Property allocation is subject to completion of the agreed payment plan and verification of funds. Keep this receipt safely; present it for allocation and documentation.
          </p>

          <div className="mt-6 flex items-center justify-center">
            <a href={`/api/r/${token}/pdf`} className="mono text-[11px] bg-[#16281F] text-[#F5EFE2] px-4 py-2 rounded-full hover:bg-[#1B2E23]">Download PDF</a>
          </div>
        </div>
      </div>
      <div className="max-w-[800px] mx-auto mt-6 text-center mono text-[11px] text-[#8B6B4E]">
        Keep this private link safe — it always shows your receipt, and the QR code on the PDF opens it.
      </div>
    </div>
  );
}
