import { notFound } from "next/navigation";
import StatusBadge from "@/components/admin/StatusBadge";
import { WarnIcon } from "@/components/admin/icons";
import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { redirect } from "next/navigation";
import { formatNaira } from "@/lib/currency";
import { formatDisplayName } from "@/lib/formatName";
import { formatDate, formatDateTime } from "@/lib/booking-ui";
import { formatDateDMY } from "@/lib/time";
import { getTransactionSummary } from "@/lib/finance";
import ActivitySection from "@/components/admin/ActivitySection";
export const dynamic = "force-dynamic";
import PaymentSchedule from "./PaymentSchedule";
import PaymentVerificationButtons from "./PaymentVerificationButtons";
import CorrectPaymentDialog from "./CorrectPaymentDialog";
import ReconcileButton from "./ReconcileButton";
import CorrectionsPanel from "./CorrectionsPanel";
import StatementsPanel from "./StatementsPanel";
import ScheduleStatementPanel from "./ScheduleStatementPanel";
import TruncatedNote from "./TruncatedNote";
import { buildStatementRows } from "@/lib/statement";
import { buildStatementModel } from "@/lib/statement-model";
import { statementFmt } from "@/lib/statement-pdf";
import { planAllocationCapped } from "@/lib/finance/ledger";
import { appliedToLabel, installmentAppliedLabel } from "@/lib/receipt-amounts";

// Finance display labels (Paid / Late / Partial / Pending) are rendered
// directly from getTransactionSummary — no local status mapping.

// Dates go through the shared Lagos formatter (src/lib/booking-ui.ts) —
 // never server-local toLocaleString.

export default async function TransactionDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ history?: string; tab?: string }>;
}) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) redirect("/admin/login");
  const { id } = await params;
  const sp = await searchParams;
  const showAll = sp?.history === "all";
  const tab = ["overview", "payments", "documents", "ledger", "activity"].includes(sp?.tab ?? "")
    ? (sp?.tab as string)
    : "overview";
  const transaction = await prisma.transaction.findUnique({
    where: { id },
    include: {
      paymentPlan: true,
      installments: { orderBy: { installmentNumber: "asc" } },
      payments: {
        orderBy: { createdAt: "desc" },
        include: {
          allocations: { include: { installment: { select: { installmentNumber: true, type: true, scheduledAmount: true } } } },
        },
      },
      receipts: { orderBy: { issuedAt: "desc" }, omit: { pdfData: true }, include: { replacedBy: { select: { id: true, ref: true } } } },
      booking: { select: { id: true, ref: true } },
      ledgerEntries: {
        orderBy: [{ effectiveDate: "asc" }, { createdAt: "asc" }],
        include: { payment: { select: { paymentReference: true } } },
      },
      statements: { orderBy: { createdAt: "desc" }, omit: { pdfData: true } },
    },
  });
  if (!transaction) notFound();

  // Money figures come from the finance service (rule 3) — same numbers as
  // the dashboard and sidebar. Stored columns are display cache only.
  // Detail pages audit any row (includeTest); lists/metrics hide fixtures.
  // Independent reads run together: each DB round trip costs a full RTT, so
  // awaiting them one by one adds seconds to this page.
  const [summary, correctAudits, preview] = await Promise.all([
    getTransactionSummary(transaction.id, undefined, undefined, { includeTest: true }),
    prisma.auditEvent.findMany({
      where: { entityId: { in: transaction.payments.map((p: any) => p.id) }, action: "payment.correct" },
      select: { entityId: true, actorName: true, createdAt: true, after: true },
    }),
    buildStatementModel(prisma as never, { transactionId: transaction.id, draft: true }),
  ]);
  if (!summary) notFound();
  const overdueCount = summary.overdueCount;
  const progress = summary.progressPct.toFixed(2);
  const totalPaid = summary.confirmedPaid;
  const outstanding = summary.outstanding;

  // Payment History data: effective entries (superseded excluded unless the
  // toggle is on), oldest first. Allocations come from the stored rows.
  const allPayments = [...transaction.payments].sort(
    (a: any, b: any) => new Date(a.paymentDate).getTime() - new Date(b.paymentDate).getTime()
  );
  const effectivePayments = allPayments.filter((p: any) => p.status !== "CANCELLED");
  const supersededPayments = allPayments.filter((p: any) => p.status === "CANCELLED");
  const listedPayments = showAll ? allPayments : effectivePayments;
  const confirmedSum = effectivePayments
    .filter((p: any) => p.status === "CONFIRMED")
    .reduce((s: number, p: any) => s + p.amount, 0);
  const correctAuditByPayment = new Map(correctAudits.map((a) => [a.entityId, a]));

  const instLabelOf = (n: number, type: string) => installmentAppliedLabel(n, type);
  // "Applied to" from allocation rows; pending payments preview through the
  // same waterfall the confirm step will run.
  const appliedTo = (p: any): string => {
    if (p.allocations && p.allocations.length > 0) {
      const byInst = new Map<string, { installmentNumber: number; type: string; amount: number; scheduled: number }>();
      for (const a of p.allocations) {
        const cur = byInst.get(a.installmentId) ?? {
          installmentNumber: a.installment.installmentNumber,
          type: a.installment.type,
          amount: 0,
          scheduled: a.installment.scheduledAmount,
        };
        cur.amount += a.amount;
        byInst.set(a.installmentId, cur);
      }
      return appliedToLabel(
        [...byInst.values()].map((v) => ({
          installmentNumber: v.installmentNumber,
          type: v.type,
          amount: v.amount,
          scheduledAmount: v.scheduled,
        }))
      );
    }
    if (p.status === "PENDING_VERIFICATION") {
      try {
        const { plan } = planAllocationCapped(
          transaction.installments.map((i: any) => ({ id: i.id, installmentNumber: i.installmentNumber, scheduledAmount: i.scheduledAmount, paidAmount: summary.installments.find((s) => s.id === i.id)?.confirmedPaid ?? 0 })),
          null,
          p.amount
        );
        if (plan.length === 0) return "No schedule capacity (credit?)";
        return `Will apply to ${plan
          .map((s) => {
            const inst = transaction.installments.find((i: any) => i.id === s.installmentId) ?? {
              installmentNumber: -1,
              type: "MONTHLY",
            };
            return `${instLabelOf(inst.installmentNumber, inst.type)} ${formatNaira(s.amount)}`;
          })
          .join(", ")}`;
      } catch {
        return "Exceeds the outstanding balance — reduce the amount";
      }
    }
    return "—";
  };
  // Next-due from the shared helper (carry-forward aware), not a local find.
  const nextDue = summary.nextInstallment;
  const nextDueDays =
    summary.daysOverdue !== null && summary.daysOverdue !== undefined
      ? `Overdue by ${summary.daysOverdue} day${summary.daysOverdue === 1 ? "" : "s"}`
      : summary.daysUntilDue === 0
        ? "due today"
        : summary.daysUntilDue === 1
          ? "due tomorrow"
          : summary.daysUntilDue !== null && summary.daysUntilDue !== undefined
            ? `in ${summary.daysUntilDue} days`
            : null;

  // Statement preview from the SAME line model as the PDF
  // (buildStatementModel: ledger service only, contract fallback, shared
  // ordering, exclusions) with the SAME formatters — page and PDF can never
  // disagree. The internal table below shows the full unfiltered ledger.
  // (Built in the Promise.all above, alongside the summary and audits.)
  const unmatchedCount = effectivePayments.filter(
    (p) => !(p.verificationNote ?? "").includes("Reconciled:")
  ).length;

  return (
    <div className="min-h-screen bg-[var(--ops-bg)]">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-7 py-6">
        <Link href="/admin/transactions" className="back">← TRANSACTIONS</Link>

        <div className="card hdr">
          <div className="hdr-top">
            <div>
              <h1>{formatDisplayName(transaction.customerName)} <StatusBadge status={transaction.status} className="px-3 py-1 text-xs" /></h1>
              <div className="sub mono">{transaction.ref} · {transaction.estate}{transaction.unitType ? ` · ${transaction.unitType}` : ""}{transaction.plotCode ? ` · ${transaction.plotCode}` : ""}{transaction.booking ? <> · <Link href={`/admin/bookings/${transaction.booking.id}`} className="text-[var(--ops-primary)] hover:underline">Booking {transaction.booking.ref} ↗</Link></> : transaction.manualReason ? ` · Manual: ${transaction.manualReason}` : ""}</div>
            </div>
            <div className="acts">
              <a href="#schedule" className="btn pri">Record payment</a>
            </div>
          </div>
          <div className="stats">
            <div className="stat"><small>Total price</small><b className="price">{formatNaira(transaction.totalPayable)}</b><span>{transaction.plotQuantity} plot{transaction.plotQuantity > 1 ? "s" : ""}</span></div>
            <div className="stat"><small>Paid</small><b className="price">{formatNaira(totalPaid)}</b><span>{effectivePayments.length} payments</span></div>
            <div className="stat dk"><small>Outstanding</small><b className="price">{outstanding < 0 ? `Credit ${formatNaira(-outstanding)}` : formatNaira(outstanding)}</b><span>{progress}% paid</span></div>
            <div className="stat"><small>Next due</small><b className="price">{nextDue ? formatNaira(nextDue.amountDue) : "—"}</b><span>{nextDue ? `${nextDue.type === "INITIAL" ? "Initial" : `Month ${nextDue.number}`} · ${formatDate(nextDue.dueDate)}${nextDueDays ? ` · ${nextDueDays}` : ""}` : "Fully paid"}</span></div>
          </div>
          <div className="bar"><i style={{ width: `${Math.min(100, Number(progress))}%` }} /></div>
          <div className="mono text-[11px] text-[var(--ops-muted)] mt-2">Created {formatDateTime(transaction.createdAt)} · {transaction.installments.length} installments · {overdueCount} overdue</div>
        </div>

        <div className="tabs sticky top-16 z-10" style={{ overflowX: "auto" }}>
          {(
            [
              ["overview", "Overview", null],
              ["payments", "Payments", effectivePayments.length],
              ["documents", "Documents", null],
              ["ledger", "Ledger", null],
              ["activity", "Activity", null],
            ] as [string, string, number | null][]
          ).map(([v, label, n]) => (
            <Link key={v} href={`/admin/transactions/${transaction.id}?tab=${v}${showAll ? "&history=all" : ""}`} className={`tab${tab === v ? " on" : ""}`}>
              {label}{n !== null ? <em>{n}</em> : ""}
            </Link>
          ))}
          <div className="sp" />
          <a href="#schedule" className="btn pri sm" style={{ marginBottom: 6, flexShrink: 0 }}>Record payment</a>
        </div>

        {tab === "overview" && (
          <div className="space-y-4">
            {preview.contractAssumed && (
              <div className="attn"><WarnIcon size={14} /><span><b>Contract date is assumed from the first payment ({preview.contractDate}).</b> The sale itself may be older — a payment date only says when money arrived. Set the real sale date so the statement starts in the right place.</span><span className="sp" /><a href="#corrections" className="btn sm">Set date</a></div>
            )}
            {unmatchedCount > 0 && (
              <div className="attn"><WarnIcon size={14} /><span><b>{unmatchedCount} payment date{unmatchedCount === 1 ? "" : "s"} not matched to the bank statement.</b></span><span className="sp" /><Link href={`/admin/transactions/${transaction.id}?tab=payments`} className="btn sm">Review payments</Link></div>
            )}
            <CorrectionsPanel
              transactionId={transaction.id}
              transactionRef={transaction.ref}
              customerEmail={transaction.customerEmail}
              contractDate={transaction.contractDate}
              payments={transaction.payments.map((p: any) => ({
                id: p.id,
                amount: p.amount,
                paymentDate: p.paymentDate,
                paymentReference: p.paymentReference,
                status: p.status,
                notes: p.notes,
                verificationNotes: p.verificationNotes,
                verificationNote: p.verificationNote,
                correctsPaymentId: p.correctsPaymentId,
              }))}
              receipts={transaction.receipts.map((r: any) => ({
                id: r.id,
                ref: r.ref,
                paymentId: r.paymentId,
                voidedAt: r.voidedAt,
                sentAt: r.sentAt,
                replacedBy: r.replacedBy ?? null,
              }))}
              latestStatementNumber={transaction.statements[0]?.number ?? null}
              draft={`Dear ${formatDisplayName(transaction.customerName).split(" ")[0]}, while reconciling your account we corrected how some of your payments were recorded. Your total payments of ${formatNaira(confirmedSum)} are unchanged. The attached receipts replace the earlier ones which showed different amounts, and the corrected statement shows your full position. Please disregard the earlier receipts. Your outstanding balance is ${outstanding < 0 ? `a credit of ${formatNaira(-outstanding)}` : formatNaira(outstanding)}. Contact us on +234 8103760063 if anything looks different from your records.`}
            />
            <div id="schedule" className="scroll-mt-24">            <PaymentSchedule
              transactionId={transaction.id}
              installments={summary.installments.map((i) => ({
                id: i.id,
                installmentNumber: i.installmentNumber,
                type: i.type,
                dueDate: i.dueDate.toISOString(),
                scheduledAmount: i.scheduledAmount,
                confirmedPaid: i.confirmedPaid,
                pendingTotal: i.pendingTotal,
                status: i.status,
                overdue: i.overdue,
              }))}
              payments={transaction.payments.map((p: any) => ({
                id: p.id,
                installmentId: p.installmentId,
                amount: p.amount,
                paymentDate: new Date(p.paymentDate).toISOString(),
                paymentMethod: p.paymentMethod,
                paymentReference: p.paymentReference,
                bankReference: p.bankReference,
                notes: p.notes,
                status: p.status,
                isCredit: p.isCredit ?? false,
                creditAmount: p.creditAmount ?? null,
                allocations: (p.allocations ?? []).map((a: { installmentId: string; amount: number }) => ({ installmentId: a.installmentId, amount: a.amount })),
              }))}
              receipts={transaction.receipts.map((r: any) => ({ id: r.id, paymentId: r.paymentId }))}
              outstanding={outstanding}
              totals={{ totalPaid, totalPayable: transaction.totalPayable }}
              contractDate={transaction.contractDate ? new Date(transaction.contractDate).toISOString() : null}
              existingReferences={effectivePayments.flatMap((p) => (p.bankReference ? [p.bankReference] : []))}
            /></div>
            <div className="card">
              <div className="card-h"><h3>Latest payments</h3><Link href={`/admin/transactions/${transaction.id}?tab=payments`} className="lnk">All {effectivePayments.length} →</Link></div>
            {[...effectivePayments].slice(-3).reverse().map((p) => (
              <div key={p.id} className="row">
                <div className="tx"><b className="price">{formatNaira(p.amount)}</b><small>{formatDate(p.paymentDate)} · {p.paymentMethod ?? "Bank transfer"}</small></div>
                <StatusBadge status={p.status} className="px-2 py-0.5 text-[10px]" />
              </div>
            ))}
            </div>
          </div>
        )}
        {tab === "payments" && (
            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Payment History</h2>
                {supersededPayments.length > 0 && (
                  <Link
                    href={showAll ? `/admin/transactions/${transaction.id}?tab=payments` : `/admin/transactions/${transaction.id}?tab=payments&history=all`}
                    className="mono text-[11px] text-[var(--ops-primary)] hover:underline underline-offset-4"
                  >
                    {showAll ? "Hide superseded entries" : `Show superseded entries (${supersededPayments.length})`}
                  </Link>
                )}
              </div>
              <p className="mono text-[11px] text-[var(--ops-muted)] mt-1">
                {effectivePayments.length} payments · {formatNaira(confirmedSum)} confirmed · {outstanding < 0 ? `Credit ${formatNaira(-outstanding)}` : formatNaira(outstanding)} outstanding
              </p>
              {listedPayments.length === 0 ? (
                <p className="mono text-[11px] text-[var(--ops-muted)] mt-3">No payments recorded yet.</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {listedPayments.map((p: any) => {
                    const isSuperseded = p.status === "CANCELLED";
                    const replacement = allPayments.find((x: any) => x.correctsPaymentId === p.id);
                    const replacementReceipt = replacement ? transaction.receipts.find((r: any) => r.paymentId === replacement.id) : null;
                    const receipt = transaction.receipts.find((r: any) => r.paymentId === p.id);
                    const original = p.correctsPaymentId ? allPayments.find((x: any) => x.id === p.correctsPaymentId) : null;
                    const originalReceipt = original ? transaction.receipts.find((r: any) => r.paymentId === original.id) : null;
                    const audit = correctAuditByPayment.get(p.id) as { actorName: string; createdAt: Date; after: any } | undefined;
                    const after = (audit?.after ?? {}) as { amount?: number; reason?: string };
                    const unconfirmed = !(p.verificationNote ?? "").includes("Reconciled:");
                    return (
                      <div key={p.id} id={`payment-${p.id}`} className={`flex gap-3 p-3 rounded-xl border border-[var(--ops-border)] bg-[var(--ops-bg)]/30 scroll-mt-20 ${isSuperseded ? "opacity-60" : ""}`}>
                        <div className="h-8 w-8 rounded-full bg-[#0D3328] text-white grid place-items-center text-[11px] shrink-0">₦</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className={`text-[13px] font-medium price ${isSuperseded ? "line-through" : ""}`}>{formatNaira(p.amount)}</span>
                            <span className="mono text-[11px] text-[var(--ops-muted)]">{formatDate(p.paymentDate)}</span>
                          </div>
                          <div className="mono text-[11px] text-[var(--ops-muted)]">
                            Applied to: {appliedTo(p)}
                          </div>
                          <div className="mono text-[11px] text-[var(--ops-muted)]">{p.paymentMethod ?? "-"}{p.bankReference ? ` · bank: ${p.bankReference}` : ""}{p.notes ? <TruncatedNote text={p.notes} /> : ""}</div>
                          <div className="mono text-[10px] text-[var(--ops-muted)] font-mono">{p.paymentReference}</div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <StatusBadge status={p.status} className="px-2 py-0.5 text-[10px]" />
                            {p.correctsPaymentId && <span className="mono text-[10px] px-2 py-0.5 rounded-full bg-[#E0F2F1] text-[#0D3328] border border-[#B2DFDB]">Corrected</span>}
                            {isSuperseded && <span className="mono text-[10px] px-2 py-0.5 rounded-full bg-[#F3F4F6] text-[#4B5563] border border-[#E5E7EB]">Superseded</span>}
                            {!isSuperseded && unconfirmed && <span className="mono text-[10px] px-2 py-0.5 rounded-full bg-[#FFFBEB] text-[#92400E] border border-[#FDE68A]">Date unconfirmed</span>}
                            {(p.status === "CONFIRMED" || p.status === "PENDING_VERIFICATION") && (
                              <ReconcileButton
                                transactionId={transaction.id}
                                paymentId={p.id}
                                reconciled={!unconfirmed}
                              />
                            )}
                          </div>
                          {p.correctsPaymentId && original && (
                            <div className="mono text-[11px] text-[var(--ops-muted)] mt-1">
                              Originally recorded as {formatNaira(original.amount)}.
                              {audit ? ` Corrected ${formatDateDMY(audit.createdAt)} by ${audit.actorName}.` : ""}
                              {after.reason ? ` Reason: ${after.reason}` : ""}
                              {" "}<a href="#corrections" className="text-[var(--ops-primary)] hover:underline underline-offset-4">View correction</a>
                            </div>
                          )}
                          {p.verificationNote && <div className="mono text-[11px] text-[var(--ops-muted)] mt-1">Verified: {p.verificationNote}</div>}
                          {receipt && (
                            <div className="mono text-[11px] mt-1">
                              <Link href={`/admin/receipts/${receipt.id}`} className="text-[var(--ops-primary)] hover:underline">Receipt: {receipt.ref}</Link>
                              {receipt.voidedAt ? <span className="ml-2 text-red-700 font-medium">VOID</span> : ""}
                              {originalReceipt && (
                                <> <span className="text-[var(--ops-muted)]">replaces</span> <Link href={`/admin/receipts/${originalReceipt.id}`} className="text-[var(--ops-primary)] hover:underline">{originalReceipt.ref}</Link> <span className="text-red-700">(VOID)</span></>
                              )}
                            </div>
                          )}
                          {isSuperseded && replacement && (
                            <div className="mono text-[11px] mt-1">
                              <span className="text-[var(--ops-muted)]">Replaced by</span>{" "}
                              <a href={`#payment-${replacement.id}`} className="text-[var(--ops-primary)] hover:underline">{formatNaira(replacement.amount)} · {replacement.paymentReference}</a>
                              {replacementReceipt && <> · <Link href={`/admin/receipts/${replacementReceipt.id}`} className="text-[var(--ops-primary)] hover:underline">{replacementReceipt.ref}</Link></>}
                            </div>
                          )}
                          {p.status === "CONFIRMED" && (
                            <div className="flex flex-wrap items-center gap-2">
                              <PaymentVerificationButtons
                                transactionId={transaction.id}
                                paymentId={p.id}
                                allowConfirm={false}
                                payment={{ amount: p.amount, installmentLabel: appliedTo(p), isCredit: p.isCredit, creditAmount: p.creditAmount }}
                                totals={{ totalPaid, totalPayable: transaction.totalPayable }}
                              />
                              <CorrectPaymentDialog
                                transactionId={transaction.id}
                                paymentId={p.id}
                                paymentLabel={`${formatNaira(p.amount)} · ${p.paymentReference}`}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

        )}
        {tab === "documents" && (
          <div className="space-y-4">
            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              {transaction.receipts.length === 0 ? (
                <p className="mono text-[11px] text-[var(--ops-muted)] mt-3">No receipts yet.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {transaction.receipts.map((r: any) => (
                    <Link key={r.id} href={`/admin/receipts/${r.id}`} className="block p-3 rounded-xl border border-[var(--ops-border)] hover:bg-[var(--ops-bg)]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="font-mono text-[12px] font-medium text-[var(--ops-primary)]">{r.ref}{r.voidedAt ? <span className="ml-2 text-red-700">VOID</span> : ""}</div>
                        {(r.pdfStatus === "FAILED" || !r.sentAt) && (
                          <span className="mono text-[10px] px-2 py-0.5 rounded-full bg-[#A6402F] text-white">Needs retry →</span>
                        )}
                      </div>
                      <div className="mono text-[11px] text-[var(--ops-muted)]">{formatDate(r.issuedAt)} · {r.sentAt ? "Emailed" : "Not emailed"} · {formatNaira(r.finalAmount)}</div>
                    </Link>
                  ))}
                </div>
              )}
            </div>

            <StatementsPanel
              transactionId={transaction.id}
              transactionRef={transaction.ref}
              statements={transaction.statements.filter((s: any) => s.kind !== "SCHEDULE").map((s: any) => ({
                id: s.id,
                number: s.number,
                asAt: formatDate(s.asAt),
                closingBalance: s.closingBalance,
                emailed: s.emailSentAt ? { at: formatDateTime(s.emailSentAt), to: s.emailRecipient ?? "-" } : null,
                defaultTo: transaction.customerEmail,
              }))}
            />

            <ScheduleStatementPanel
              transactionId={transaction.id}
              transactionRef={transaction.ref}
              statements={transaction.statements.filter((s: any) => s.kind === "SCHEDULE").map((s: any) => ({
                id: s.id,
                number: s.number,
                asAt: formatDate(s.asAt),
                outstanding: s.closingBalance,
                emailed: s.emailSentAt ? { at: formatDateTime(s.emailSentAt), to: s.emailRecipient ?? "-" } : null,
                defaultTo: transaction.customerEmail,
              }))}
            />
          </div>
        )}
        {tab === "ledger" && (
          <div className="space-y-4">
            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Statement preview (effective — matches the PDF)</h2>
              {preview.contractAssumed && (
                <p className="mono text-[11px] text-[#92400E] mt-2">Contract date assumed ({preview.contractDate}, earliest payment) — set the real sale date.</p>
              )}
              {preview.rows.length === 0 ? (
                <p className="mono text-[11px] text-[var(--ops-muted)] mt-3">No ledger entries yet.</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead>
                      <tr className="bg-[var(--ops-bg)]/60 border-b border-[var(--ops-border)] text-left mono text-[10px] uppercase text-[var(--ops-muted)]">
                        <th className="px-3 py-2">Date</th><th className="px-3 py-2">Details</th><th className="px-3 py-2 text-right">Charges</th><th className="px-3 py-2 text-right">Payments</th><th className="px-3 py-2 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ops-border)]/60">
                      {preview.rows.map((r, i) => (
                        <tr key={i} className="hover:bg-[var(--ops-bg)]/30">
                          <td className="px-3 py-2 mono text-[11px]">{r.date}</td>
                          <td className="px-3 py-2 text-[13px]">{r.line1}{r.line2 ? <div className="mono text-[10px] text-[var(--ops-muted)]">{r.line2}</div> : null}</td>
                          <td className="px-3 py-2 mono text-[11px] text-right price">{statementFmt.cell(r.charge)}</td>
                          <td className="px-3 py-2 mono text-[11px] text-right price">{statementFmt.cell(r.payment)}</td>
                          <td className="px-3 py-2 mono text-[11px] text-right price">{statementFmt.money(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mono text-[11px] text-[var(--ops-muted)] mt-2">
                Closing {statementFmt.money(preview.closing.balance)} · Total charges {statementFmt.cell(preview.totals.charges)} · Total paid {statementFmt.cell(preview.totals.payments)}
              </p>
              <p className="mono text-[10px] text-[var(--ops-muted)] mt-1">Client view: superseded entries excluded, no corrections note — exactly what the issued PDF shows. Generate a statement below for the PDF.</p>
            </div>

            <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
              <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Internal ledger (full history)</h2>
              {transaction.ledgerEntries.length === 0 ? (
                <p className="mono text-[11px] text-[var(--ops-muted)] mt-3">No ledger entries yet.</p>
              ) : (
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead>
                      <tr className="bg-[var(--ops-bg)]/60 border-b border-[var(--ops-border)] text-left mono text-[10px] uppercase text-[var(--ops-muted)]">
                        <th className="px-3 py-2">Date</th><th className="px-3 py-2">Details</th><th className="px-3 py-2 text-right">Charges</th><th className="px-3 py-2 text-right">Payments</th><th className="px-3 py-2 text-right">Balance</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ops-border)]/60">
                      {buildStatementRows(transaction.ledgerEntries.map((e) => ({
                        id: e.id,
                        type: e.type,
                        amount: e.amount,
                        direction: e.direction,
                        effectiveDate: e.effectiveDate,
                        createdAt: e.createdAt,
                        method: e.method,
                        bankReference: e.bankReference,
                      }))).rows.map((r, i) => (
                        <tr key={i} className="hover:bg-[var(--ops-bg)]/30">
                          <td className="px-3 py-2 mono text-[11px]">{r.date}</td>
                          <td className="px-3 py-2 text-[13px]">{r.details}{r.line2 ? <div className="mono text-[10px] text-[var(--ops-muted)]">{r.line2}</div> : null}</td>
                          <td className="px-3 py-2 mono text-[11px] text-right price">{r.debit != null ? formatNaira(r.debit) : "-"}</td>
                          <td className="px-3 py-2 mono text-[11px] text-right price">{r.credit != null ? formatNaira(r.credit) : "-"}</td>
                          <td className="px-3 py-2 mono text-[11px] text-right price">{formatNaira(r.balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mono text-[10px] text-[var(--ops-muted)] mt-2">Internal view: includes reversed entries. The client statement shows the effective ledger only.</p>
            </div>


          </div>
        )}
        {tab === "activity" && (
          <div className="card pad">
            <ActivitySection entityType="transaction" entityId={transaction.id} />
          </div>
        )}
      </div>
    </div>
  );
}
