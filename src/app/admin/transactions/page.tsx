import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatNaira, formatSignedNaira } from "@/lib/currency";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { redirect } from "next/navigation";
import AdminPagination from "@/components/admin/AdminPagination";
import AdminListCard from "@/components/admin/AdminListCard";
import ClickableRow from "@/components/admin/ClickableRow";
import { getTransactionOverviews } from "@/lib/finance";
import type { TransactionOverview } from "@/lib/finance";
import { formatDate } from "@/lib/booking-ui";
export const dynamic = "force-dynamic";

// Colour rules (single place for this list): a paid installment never leaves
// a red figure. Red is reserved for genuinely overdue dues; amber means due
// within 7 days; anything on schedule is neutral; zero is green.
function outstandingClass(ov: TransactionOverview): string {
  if (ov.isFullyPaid) return "text-[#065F46]";
  if (ov.isOverdue) return "text-[#9F1239]";
  if (ov.daysUntilDue !== null && ov.daysUntilDue <= 7) return "text-[#92400E]";
  return "text-[var(--ops-text)]";
}

function daysPhrase(ov: TransactionOverview): string | null {
  if (ov.daysOverdue !== null && ov.daysOverdue !== undefined) {
    return `Overdue by ${ov.daysOverdue} day${ov.daysOverdue === 1 ? "" : "s"}`;
  }
  if (ov.daysUntilDue === null || ov.daysUntilDue === undefined) return null;
  if (ov.daysUntilDue === 0) return "due today";
  if (ov.daysUntilDue === 1) return "due tomorrow";
  return `in ${ov.daysUntilDue} days`;
}

// Derived row chip (draft v2 language): Paid in full / Behind / On track.
// Computed from confirmed money via the finance service — never the stored
// status label. The behind amount lives on the detail page.
function stateChip(ov: TransactionOverview) {
  if (ov.isOverpaid) return <span className="chip green">Overpaid</span>;
  if (ov.isFullyPaid) return <span className="chip green">Paid in full</span>;
  if (ov.isOverdue) return <span className="chip red">Behind</span>;
  return <span className="chip lg">On track</span>;
}

// "Next payment due" line beneath Outstanding: amount + due date from the
// shared helper (first unpaid installment after carry-forward), or
// "Fully paid" once cleared.
function nextDueLine(ov: TransactionOverview) {
  if (ov.isOverpaid) {
    return <div className="mono text-[10px] text-[#065F46]">Credit {formatNaira(ov.overpaidAmount)} · settled</div>;
  }
  if (ov.isFullyPaid || !ov.nextInstallment) {
    return <div className="mono text-[10px] text-[#065F46]">Fully paid</div>;
  }
  const n = ov.nextInstallment;
  const head = `${formatNaira(n.amountDue)} due ${formatDate(n.dueDate)}`;
  const tail = daysPhrase(ov);
  if (ov.isOverdue) {
    return <div className="mono text-[10px] text-[#9F1239]">{head}{tail ? ` · ${tail}` : ""}</div>;
  }
  if (ov.daysUntilDue !== null && ov.daysUntilDue <= 7) {
    return <div className="mono text-[10px] text-[#92400E]">{head}{tail ? ` · ${tail}` : ""}</div>;
  }
  return <div className="mono text-[10px] text-[var(--ops-muted)]">{head}{tail ? ` · ${tail}` : ""}</div>;
}

type SearchParams = { q?: string; status?: string; plan?: string; page?: string; showTest?: string };

const PAGE_SIZE = 25;

export default async function TransactionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) redirect("/admin/login");
  const params = await searchParams;
  const page = Math.max(1, Number(params.page) || 1);
  const q = params.q?.trim() ?? "";
  const status = params.status ?? "";
  const plan = params.plan ?? "";
  const showTest = params.showTest === "1";

  const where: any = {};
  if (!showTest) where.isTest = false;
  if (status) where.status = status;
  if (plan) where.paymentPlanId = plan;
  if (q) {
    where.OR = [
      { ref: { contains: q, mode: "insensitive" } },
      { customerName: { contains: q, mode: "insensitive" } },
      { customerEmail: { contains: q, mode: "insensitive" } },
      { estate: { contains: q, mode: "insensitive" } },
      { plotCode: { contains: q, mode: "insensitive" } },
    ];
  }

  const [transactions, total, plans] = await Promise.all([
    prisma.transaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { paymentPlan: true },
    }),
    prisma.transaction.count({ where }),
    prisma.paymentPlan.findMany({ where: { isActive: true } }),
  ]);

  // Money figures from the finance service (rule 3) — never stored-column
  // reads or inline filters here.
  const overviews = await getTransactionOverviews(transactions.map((t) => t.id));

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const paginationQuery = (() => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (status) qs.set("status", status);
    if (plan) qs.set("plan", plan);
    if (showTest) qs.set("showTest", "1");
    return qs.toString();
  })();
  function buildQuery(overrides: Partial<SearchParams>) {
    const merged = { ...params, ...overrides };
    const qs = new URLSearchParams();
    if (merged.q) qs.set("q", merged.q);
    if (merged.status) qs.set("status", merged.status);
    if (merged.plan) qs.set("plan", merged.plan);
    if (merged.showTest) qs.set("showTest", merged.showTest);
    if (merged.page && merged.page !== "1") qs.set("page", merged.page);
    const str = qs.toString();
    return str ? `?${str}` : "";
  }

  return (
    <div className="min-h-screen bg-[var(--ops-bg)]">
      <div className="max-w-[1180px] mx-auto px-6 lg:px-7 py-6">
        <div className="ph">
          <div>
            <h1>Transactions</h1>
            <p>Every sale, what has been paid and what is left. · {total} transactions · Page {page} of {totalPages}</p>
          </div>
          <div className="acts">
            <Link href="/admin/transactions/new" className="btn pri">+ New transaction</Link>
            <a href={`/api/admin/transactions/ledger${buildQuery({ page: undefined })}`} className="btn">Ledger PDF</a>
            <Link href="/admin/receipts" className="btn">Receipts</Link>
          </div>
        </div>

        <div className="card">
          <div className="filters">
            {[{ label: "All", value: "" }, { label: "Active", value: "ACTIVE" }, { label: "Paid in full", value: "PAID_IN_FULL" }, { label: "Draft", value: "DRAFT" }].map((f) => {
              const active = (status ?? "") === f.value;
              return <Link key={f.label} href={`/admin/transactions${buildQuery({ status: f.value || undefined, page: "1" })}`} className={`fp${active ? " on" : ""}`}>{f.label}</Link>;
            })}
            {[{ label: "All plans", value: "" }, ...plans.map((p) => ({ label: p.name, value: p.id }))].map((f) => {
              const active = (plan ?? "") === f.value;
              return <Link key={f.label} href={`/admin/transactions${buildQuery({ plan: f.value || undefined, page: "1" })}`} className={`fp${active ? " on" : ""}`}>{f.label}</Link>;
            })}
            <form className="fs" action="/admin/transactions" method="get" style={{ flex: 1 }}>
              {status && <input type="hidden" name="status" value={status} />}
              {plan && <input type="hidden" name="plan" value={plan} />}
              <input name="q" defaultValue={q} placeholder="Search reference, client, property" style={{ border: "none", outline: "none", background: "transparent", flex: 1, fontSize: "12.5px" }} />
              {(q || status || plan) && <Link href="/admin/transactions" className="lnk">Clear</Link>}
            </form>
          </div>
          <div className="hidden lg:block overflow-x-auto">
            <table className="t">
              <thead>
                <tr><th>Transaction</th><th>Client</th><th>Property</th><th>Plan</th><th className="r">Total</th><th className="r">Outstanding</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {transactions.map((t) => {
                  const ov = overviews.get(t.id);
                  if (!ov) return null;
                  const outstanding = ov.outstanding;
                  return (
                    <ClickableRow key={t.id} href={`/admin/transactions/${t.id}`}>
                      <td className="num"><Link href={`/admin/transactions/${t.id}`} className="row-lead font-medium text-[var(--ops-text)] hover:underline">{t.ref}</Link><small>{t.plotCode ?? ""} {t.sqm ? `· ${t.sqm}sqm` : ""}</small></td>
                      <td><b>{t.customerName}</b><small>{t.customerEmail}</small></td>
                      <td>{t.estate}<small>{t.unitType ?? ""} {t.plotCode ?? ""}</small></td>
                      <td>{t.paymentPlan.name}</td>
                      <td className="r num">{formatNaira(t.totalPayable)}</td>
                      <td className="r num"><span className={outstandingClass(ov)}>{formatSignedNaira(outstanding)}</span><small>{ov.isOverpaid ? `Credit ${formatNaira(ov.overpaidAmount)}` : ov.isFullyPaid ? "Fully paid" : ov.nextInstallment ? `${formatNaira(ov.nextInstallment.amountDue)} · ${daysPhrase(ov) ?? ""}` : ""}</small></td>
                      <td>{stateChip(ov)}</td>
                      <td className="r">›</td>
                    </ClickableRow>
                  );
                })}
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={8}><div className="empty">No transactions. Create one from a booking or manually.</div></td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="lg:hidden space-y-3 mt-4">
          {transactions.map((t) => {
            const ov = overviews.get(t.id);
            if (!ov) return null;
            return (
              <AdminListCard
                key={t.id}
                href={`/admin/transactions/${t.id}`}
                refText={t.ref}
                name={t.customerName}
                email={t.customerEmail}
                badges={stateChip(ov)}
                rows={[
                  { label: "Property", value: t.estate },
                  {
                    label: "Outstanding",
                    value: (
                      <span>
                        <span className={`mono text-[12px] font-bold price ${outstandingClass(ov)}`}>{formatSignedNaira(ov.outstanding)}</span>
                        {nextDueLine(ov)}
                      </span>
                    ),
                  },
                  { label: "Total", value: <span className="mono text-[11px] price">{formatNaira(t.totalPayable)}</span> },
                  { label: "Plan", value: <span className="mono text-[11px]">{t.paymentPlan.name}</span> },
                ]}
              />
            );
          })}
        </div>

        <AdminPagination page={page} totalPages={totalPages} total={total} pageSize={PAGE_SIZE} basePath="/admin/transactions" query={paginationQuery} />
      </div>
    </div>
  );
}
