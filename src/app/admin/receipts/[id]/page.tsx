import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { redirect } from "next/navigation";
import StatusBadge from "@/components/admin/StatusBadge";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatNaira } from "@/lib/currency";
import { formatDisplayName } from "@/lib/formatName";
import { formatDateTime } from "@/lib/booking-ui";
import { receiptAmountsRows, buildReceiptHistory, buildAccountRef, settlementCopy } from "@/lib/receipt-amounts";
import ActivitySection from "@/components/admin/ActivitySection";
export const dynamic = "force-dynamic";
import ReceiptActions from "./ReceiptActions";

// Dates go through the shared Lagos formatter (src/lib/booking-ui.ts).
export default async function ReceiptDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) redirect("/admin/login");
  const { id } = await params;
  const receipt = await prisma.receipt.findUnique({
    where: { id },
    omit: { pdfData: true },
    include: {
      booking: { select: { id: true, ref: true, status: true, location: true } },
      payment: { select: { id: true, paymentReference: true, amount: true, paymentDate: true, paymentMethod: true, bankReference: true, correctsPaymentId: true, installment: { select: { type: true, installmentNumber: true } }, allocations: { select: { amount: true, installment: { select: { type: true, installmentNumber: true, scheduledAmount: true } } } } } },
      replacedBy: { select: { id: true, ref: true } },
      transaction: {
        select: {
          id: true, ref: true, bookingId: true, manualReason: true, totalPayable: true,
          unitPrice: true, plotQuantity: true, interestAmount: true,
          booking: { select: { id: true, ref: true } },
          payments: { where: { status: "CONFIRMED" }, select: { id: true, amount: true, paymentDate: true, paymentMethod: true } },
          receipts: { select: { paymentId: true, ref: true } },
        },
      },
      agent: { select: { name: true, email: true } },
      createdBy: { select: { name: true, email: true } },
    },
  });
  if (!receipt) notFound();

  // Replacement linkage: this receipt supersedes the original's receipt.
  let replacesRef: string | null = null;
  const correctsId = receipt.payment?.correctsPaymentId ?? null;
  if (correctsId) {
    const original = await prisma.receipt.findFirst({ where: { paymentId: correctsId }, select: { ref: true } });
    replacesRef = original?.ref ?? null;
  }
  const emailed = !!receipt.sentAt;

  // As-of-issue figures: confirmed payments strictly before this one.
  const receiptPayment = receipt.payment;
  const confirmedList = [...(receipt.transaction?.payments ?? [])];
  if (receiptPayment && !confirmedList.some((p) => p.id === receiptPayment.id)) {
    confirmedList.push({ id: receiptPayment.id, amount: receiptPayment.amount, paymentDate: receiptPayment.paymentDate, paymentMethod: receiptPayment.paymentMethod });
  }
  const totalPrice = receipt.transaction?.totalPayable ?? receipt.amountBeforeDiscount;
  const history = buildReceiptHistory(
    confirmedList.map((p) => ({ id: p.id, date: p.paymentDate, method: p.paymentMethod ?? "Bank Transfer", amount: p.amount })),
    new Map((receipt.transaction?.receipts ?? []).map((r) => [r.paymentId as string, r.ref])),
    receipt.paymentId,
    totalPrice,
    (d) => formatDateTime(new Date(d))
  );
  const previouslyPaid = history.filter((h) => !h.isCurrent).reduce((s, h) => s + h.amount, 0);
  const paidToDate = previouslyPaid + receipt.finalAmount;
  const balanceRemaining = totalPrice - paidToDate;
  const settlement = settlementCopy({
    balanceAfter: balanceRemaining,
    settledOn: receipt.payment?.paymentDate ?? receipt.issuedAt,
    formatDate: (d) => formatDateTime(new Date(d)),
  });
  const label = settlement.headline;
  const accountRef = receipt.transaction ? buildAccountRef(receipt.transaction.ref, receipt.transaction.booking?.ref ?? null) : null;
  // Plot quantity: receipt snapshot first, live transaction as fallback.
  const plotQty = receipt.plotQuantity ?? receipt.transaction?.plotQuantity ?? null;
  const unitPrice = receipt.unitPrice ?? receipt.transaction?.unitPrice ?? null;

  return (
    <div className="min-h-screen bg-[var(--ops-bg)]">
      <div className="max-w-[1440px] mx-auto px-6 lg:px-8 py-6">
        <div className="flex items-center gap-2 mono text-[11px] tracking-wide uppercase text-[var(--ops-muted)] mb-4">
          <Link href="/admin/receipts" className="hover:text-[var(--ops-text)] flex items-center gap-1.5"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M19 12H5"/><path d="M12 19l-7-7 7-7"/></svg> Receipts</Link>
          <span className="text-[var(--ops-border)]">/</span>
          <span className="text-[var(--ops-text)] font-medium tracking-normal normal-case mono text-[11px]">{receipt.ref}</span>
        </div>

        <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 lg:p-7 shadow-[var(--ops-shadow-sm)]">
          <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-5">
            <div className="min-w-0 flex-1">
              <div className="mono text-[11px] tracking-[0.14em] uppercase text-[var(--ops-muted)]">Receipt</div>
              <div className="flex flex-wrap items-baseline gap-3 mt-1">
                <h1 className="font-serif text-[26px] lg:text-[30px] tracking-[-0.02em] text-[var(--ops-text)] leading-none">{receipt.ref}</h1>
                <span className={`inline-flex px-3 py-1.5 rounded-full text-xs font-medium border ${emailed ? "bg-[#ECFDF5] text-[#065F46] border-[#A7F3D0]" : "bg-[#FFFBEB] text-[#92400E] border-[#FDE68A]"}`}>{emailed ? "Emailed" : "Not emailed"}</span>
                <span className="inline-flex px-3 py-1.5 rounded-full text-xs font-medium border bg-white border-[var(--ops-border)] text-[var(--ops-text)]">{label}</span>
                {receipt.voidedAt && <span className="inline-flex px-3 py-1.5 rounded-full text-xs font-medium border bg-red-700 text-white border-red-700">VOID</span>}
              </div>
              {settlement.note && (
                <div className="mt-3 public text-[13px] text-[var(--ops-text)]">{settlement.note}</div>
              )}
              {receipt.voidedAt && (
                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                  Voided {formatDateTime(receipt.voidedAt)} — superseded, kept as evidence.
                  {receipt.replacedBy && (
                    <> Replacement: <Link href={`/admin/receipts/${receipt.replacedBy.id}`} className="font-mono underline underline-offset-2">{receipt.replacedBy.ref}</Link></>
                  )}
                </div>
              )}
              <div className="mono text-[11px] text-[var(--ops-muted)] mt-2">Issued {formatDateTime(receipt.issuedAt)}{receipt.sentAt ? ` · Emailed ${formatDateTime(receipt.sentAt)}` : ""}</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ReceiptActions
                receipt={{ id: receipt.id, ref: receipt.ref, receiptUrl: receipt.receiptUrl }}
                pdfHref={`/api/admin/receipts/${receipt.id}/pdf`}
              />
            </div>
          </div>
        </div>

        <div className="mt-6 grid lg:grid-cols-[1.6fr_1fr] gap-6 items-start">
          <div className="space-y-6">
            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Amounts</h2>
              <div className="mt-3 space-y-2 text-sm">
                {receiptAmountsRows({
                  thisPayment: receipt.finalAmount,
                  totalPrice: receipt.transaction?.totalPayable ?? receipt.amountBeforeDiscount,
                  interestAmount: receipt.transaction?.interestAmount ?? null,
                  paidToDate,
                  balanceRemaining,
                  discount: receipt.discount,
                }).map((row) => (
                  <div
                    key={row.key}
                    className={`flex justify-between ${row.key === "balance" ? "border-t border-[var(--ops-border)] pt-2" : ""}`}
                  >
                    <span className={row.key === "balance" ? "font-medium" : "text-[var(--ops-muted)]"}>{row.label}</span>
                    <span className={`font-mono price ${row.emphasize ? "font-bold" : ""}`}>{typeof row.value === "number" ? formatNaira(row.value) : row.value}</span>
                  </div>
                ))}
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Amount in words</span><span className="text-[12px] text-right max-w-[60%]">{receipt.amountInWords}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Description</span><span className="text-[12px] text-right max-w-[60%]">{receipt.paymentDescription}</span></div>
                {receipt.paymentMethod && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Method</span><span className="font-medium">{receipt.paymentMethod}</span></div>}
                {receipt.payment?.bankReference && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Bank ref</span><span className="font-mono text-[12px]">{receipt.payment.bankReference}</span></div>}
                {accountRef && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Account ref</span><span className="font-mono text-[12px]">{accountRef}</span></div>}
                {replacesRef && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Replaces</span><span className="font-mono text-[12px]">{replacesRef}</span></div>}
              </div>
            </div>

            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Payment history</h2>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm min-w-[560px]">
                  <thead>
                    <tr className="bg-[var(--ops-bg)]/60 border-b border-[var(--ops-border)] text-left mono text-[10px] uppercase text-[var(--ops-muted)]">
                      <th className="px-3 py-2">#</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Method</th><th className="px-3 py-2">Receipt</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ops-border)]/60">
                    {history.map((h) => (
                      <tr key={h.index} className={h.isCurrent ? "bg-[#FFFBEB]/50 font-medium" : ""}>
                        <td className="px-3 py-2 mono text-[11px]">{h.index}</td>
                        <td className="px-3 py-2 mono text-[11px]">{h.date}</td>
                        <td className="px-3 py-2 mono text-[11px]">{h.method}</td>
                        <td className="px-3 py-2 font-mono text-[11px]">{h.receiptRef ?? "-"}</td>
                        <td className="px-3 py-2 mono text-[11px] text-right price">{formatNaira(h.amount)}</td>
                        <td className="px-3 py-2 mono text-[11px] text-right price">{formatNaira(h.runningBalance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Links</h2>
              <div className="mt-3 space-y-2 text-sm">
                {receipt.payment && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Payment</span><Link href={`/admin/transactions/${receipt.transactionId}#payment-${receipt.payment.id}`} className="font-mono text-[12px] text-[var(--ops-primary)] hover:underline">{receipt.payment.paymentReference}</Link></div>}
                {receipt.transaction && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Transaction</span><Link href={`/admin/transactions/${receipt.transaction.id}`} className="font-mono text-[12px] text-[var(--ops-primary)] hover:underline">{receipt.transaction.ref}</Link></div>}
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Sale / Booking</span>{receipt.transaction?.booking ? <Link href={`/admin/bookings/${receipt.transaction.booking.id}`} className="text-[var(--ops-primary)] hover:underline font-mono text-[12px]">{receipt.transaction.booking.ref}</Link> : receipt.transaction?.manualReason ? <span className="mono text-[11px] text-[var(--ops-muted)]">Manual: {receipt.transaction.manualReason}</span> : receipt.bookingId ? <Link href={`/admin/bookings/${receipt.bookingId}`} className="text-[var(--ops-primary)] hover:underline font-mono text-[12px]">{receipt.booking?.ref ?? receipt.bookingId}</Link> : <span className="mono text-[11px] text-[var(--ops-muted)]">Manual: no booking</span>}</div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Customer</span><Link href={`/admin/search?q=${encodeURIComponent(receipt.customerEmail)}`} className="font-medium text-[var(--ops-primary)] hover:underline">{formatDisplayName(receipt.customerName)}</Link></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Client receipt page</span><a href={receipt.receiptUrl} target="_blank" className="font-mono text-[12px] text-[var(--ops-primary)] hover:underline break-words">Open ↗</a></div>
                {receipt.agentName && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Agent / Adviser</span><span className="font-medium">{receipt.agentName}</span></div>}
              </div>
            </div>

            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h3 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Property</h3>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Property</span><span className="font-medium break-words max-w-[60%] text-right">{receipt.property}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Estate</span><span className="font-medium">{receipt.estate ?? "-"}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Unit</span><span className="font-medium">{receipt.unitType ?? "-"}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">SKU / Plot Code</span><span className="font-mono text-[12px]">{receipt.plotCode ?? "-"}</span></div>
                {receipt.sqm && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">SQM</span><span className="font-medium">{receipt.sqm}sqm</span></div>}
                {plotQty != null && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Plots</span><span className="font-medium">{receipt.sqm ? `${plotQty} × ${receipt.sqm}sqm` : `${plotQty} plot${plotQty === 1 ? "" : "s"}`}</span></div>}
                {unitPrice != null && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Unit price</span><span className="font-mono price">{formatNaira(unitPrice)}</span></div>}
                {plotQty != null && unitPrice != null && <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Amount due (unit × qty)</span><span className="font-mono price font-medium">{formatNaira(unitPrice * plotQty)}</span></div>}
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Source</span><StatusBadge status={receipt.source} /></div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h3 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Email</h3>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Recipient</span><span className="font-mono text-[12px] break-words">{receipt.recipientEmail}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Emailed</span><span className="font-mono text-[12px]">{receipt.sentAt ? formatDateTime(receipt.sentAt) : "Not emailed yet"}</span></div>
                {receipt.resendEmailId && (
                  <div className="flex justify-between">
                    <span className="text-[var(--ops-muted)]">Resend message</span>
                    <a href={`https://resend.com/emails/${receipt.resendEmailId}`} target="_blank" className="font-mono text-[12px] text-[var(--ops-primary)] hover:underline break-all">Open in Resend ↗</a>
                  </div>
                )}
                <p className="mono text-[10px] text-[var(--ops-muted)] pt-1">Delivery history lives in Resend — this id links to the message there (30-day log retention).</p>
              </div>
            </div>

            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h3 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Issued</h3>
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Issued</span><span className="font-mono text-[12px]">{formatDateTime(receipt.issuedAt)}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ops-muted)]">Created by</span><span className="text-[12px]">{receipt.createdBy?.name ?? receipt.createdBy?.email ?? "-"}</span></div>
              </div>
            </div>
            <div className="mt-6">
              <ActivitySection entityType="receipt" entityId={receipt.id} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
