import { formatDateDMY, lagosDayKey } from "@/lib/time";
import { formatDisplayName } from "@/lib/formatName";
import { COMPANY } from "@/lib/documents/brand";
import {
  getEffectiveEntries,
  orderLedgerEntries,
  type TxClient,
} from "@/lib/finance/ledger";
import { chargeSubtitle, refLine } from "@/lib/statement";
import { resolveContractDate } from "@/lib/contract-date";

export const STATEMENT_LAYOUT_VERSION = "stmt-v1";

// Single source of data for every statement surface (PDF, transaction-page
// panel, public page): one function reads the ledger service only — never
// stored balance fields or ad hoc queries — and returns the line model.
// Balances are computed here, once, from the first row.

export type StatementModelRow = {
  date: string; // dd-mm-yyyy, Africa/Lagos
  line1: string;
  line2?: string;
  charge?: number; // whole naira, signed (discounts negative)
  payment?: number; // whole naira, signed (refunds negative)
  balance: number; // running balance after this row
};

export type StatementModel = {
  isDraft: boolean;
  number?: string;
  accountRef: string;
  generatedOn: string;
  asOf: string;
  company: { name: string; addressLine: string; website: string; email: string; phone: string };
  client: { name: string; phone?: string; email?: string };
  property: { estate: string; unitType: string; sku: string; plots: number };
  summary: { contractPrice: number; totalPaid: number; outstanding: number };
  rows: StatementModelRow[];
  totals: { charges: number; payments: number };
  closing: { balance: number; settled: boolean; credit: boolean };
  layoutVersion: string;
  // Internal (never printed on the client statement): guards + warnings.
  contractDate: string; // effective charge date, dd-mm-yyyy
  contractAssumed: boolean; // true when fallen back (admin UI shows "assumed")
  dataCheckErrors: string[]; // invariant failures — block Generate
  warnings: string[]; // issue-anyway items — audit-logged when accepted
};

export type StatementModelDb = TxClient & {
  transaction: {
    findUnique(args: unknown): Promise<{
      id: string;
      ref: string;
      customerName: string;
      customerEmail: string;
      customerPhone: string | null;
      estate: string;
      unitType: string | null;
      plotCode: string | null;
      plotQuantity: number;
      contractDate: Date | null;
      createdAt: Date;
    } | null>;
  };
  payment: {
    findMany(args: unknown): Promise<
      { id: string; status: string; paymentDate: Date; verificationNote: string | null; isCredit: boolean }[]
    >;
  };
};

// Payment method in Title Case ("bank transfer" → "Bank Transfer"). Stored
// method strings pass through untouched when already canonical.
export function toTitleCaseMethod(method: string | null | undefined): string {
  const s = (method ?? "").trim().replace(/\s+/g, " ");
  if (!s) return "Bank Transfer";
  return s
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function chargeLine1(type: string, note: string | null): string {
  switch (type) {
    case "CHARGE_BASE":
      return "Contract price";
    case "CHARGE_INTEREST":
      return "Interest (one-time charge)";
    case "CHARGE_FEE":
      return "Fee";
    case "DISCOUNT":
      return "Discount";
    case "WAIVER":
      return "Waiver";
    case "ADJUSTMENT":
      return note ? `Adjustment — ${note}` : "Adjustment";
    default:
      return note ? `${type} — ${note}` : type;
  }
}

export async function buildStatementModel(
  db: StatementModelDb,
  opts: { transactionId: string; asOf?: Date; draft: boolean; number?: string }
): Promise<StatementModel> {
  const now = new Date();
  const asOfDate = opts.asOf ?? now;
  const txn = await db.transaction.findUnique({ where: { id: opts.transactionId } });
  if (!txn) throw new Error("Transaction not found");

  const [entries, payments] = await Promise.all([
    getEffectiveEntries(db, opts.transactionId),
    db.payment.findMany({
      where: { transactionId: opts.transactionId },
      select: { id: true, status: true, paymentDate: true, verificationNote: true, isCredit: true },
    }),
  ]);

  const confirmed = payments.filter((p) => p.status === "CONFIRMED");
  const verifiedByPayment = new Map(confirmed.map((p) => [p.id, p.verificationNote ?? ""]));
  const creditExists = confirmed.some((p) => p.isCredit === true);

  // Contract date: explicit date wins; otherwise the earliest RECORDED
  // payment date — confirmed or still pending (a pending payment never prints
  // on the statement; it only dates the opening charge so a backdated record
  // doesn't sort the charge last and drive balances negative); otherwise
  // creation (no payments at all). Shared rule lives in @/lib/contract-date.
  // The fallback is internal-only: the client statement never prints "assumed".
  const resolved = resolveContractDate(
    { contractDate: txn.contractDate, createdAt: txn.createdAt },
    payments.map((p) => ({ status: p.status, paymentDate: p.paymentDate })),
    { includePending: true, detectCreationArtifact: false }
  );
  const contractDateUsed = resolved.date;
  const contractAssumed = resolved.assumed;
  const datedPayments = payments.filter(
    (p) => p.status === "CONFIRMED" || p.status === "PENDING_VERIFICATION"
  );

  const subtitle = chargeSubtitle(txn.estate, txn.plotCode);
  type Ranked = { id: string; type: string; effectiveDate: Date; createdAt: Date };
  const ranked: Ranked[] = entries.map((e) => ({
    id: e.id,
    type: e.type,
    // Charges are effective on the contract date (see fallback above).
    effectiveDate: e.type.startsWith("CHARGE") ? contractDateUsed : new Date(e.effectiveDate),
    createdAt: new Date(e.createdAt),
  }));
  const order = new Map(orderLedgerEntries(ranked).map((r, i) => [r.id, i]));
  const ordered = [...entries].sort(
    (a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)
  );
  // A statement of account opens with the contract price. Charges always
  // lead, then everything else in ledger (date) order — so a payment whose
  // recorded date predates the charge date follows the opening charge with
  // its real date instead of blocking generation. The first-row guard below
  // then fires only when charge entries are genuinely missing.

  const statementOrder = [
    ...ordered.filter((e) => e.type.startsWith("CHARGE")),
    ...ordered.filter((e) => !e.type.startsWith("CHARGE")),
  ];

  const rows: StatementModelRow[] = [];
  const kinds: string[] = [];
  let balance = 0;
  let totalCharges = 0;
  let totalPaid = 0;
  for (const e of statementOrder) {
    if (e.type.startsWith("CHARGE")) {
      balance += e.amount;
      totalCharges += e.amount;
      kinds.push("charge");
      rows.push({
        date: formatDateDMY(contractDateUsed),
        line1: chargeLine1(e.type, e.note),
        ...(subtitle ? { line2: subtitle } : {}),
        charge: e.amount,
        balance,
      });
    } else if (e.type === "DISCOUNT" || e.type === "WAIVER") {
      balance -= e.amount;
      totalCharges -= e.amount;
      kinds.push("discount");
      rows.push({
        date: formatDateDMY(e.effectiveDate),
        line1: e.type === "DISCOUNT" ? "Discount" : "Waiver",
        charge: -e.amount,
        balance,
      });
    } else if (e.type === "ADJUSTMENT") {
      // Downward (CREDIT) adjustments reduce what is owed: negative Charges.
      // Upward (DEBIT) adjustments add: positive Charges.
      const downward = e.direction !== "DEBIT";
      balance += downward ? -e.amount : e.amount;
      totalCharges += downward ? -e.amount : e.amount;
      kinds.push("adjustment");
      rows.push({
        date: formatDateDMY(e.effectiveDate),
        line1: e.note ? `Adjustment — ${e.note}` : "Adjustment",
        charge: downward ? -e.amount : e.amount,
        balance,
      });
    } else if (e.type === "PAYMENT" && e.direction === "DEBIT") {
      // Genuine refund path (money returned): negative Payments row.
      balance += e.amount;
      totalPaid -= e.amount;
      kinds.push("refund");
      rows.push({
        date: formatDateDMY(e.effectiveDate),
        line1: `Refund, ${toTitleCaseMethod(e.method)}`,
        ...(refLine(e.bankReference, e.receiptRef) ? { line2: refLine(e.bankReference, e.receiptRef)! } : {}),
        payment: -e.amount,
        balance,
      });
    } else if (e.type === "REFUND") {
      balance += e.amount;
      totalPaid -= e.amount;
      kinds.push("refund");
      rows.push({
        date: formatDateDMY(e.effectiveDate),
        line1: `Refund, ${toTitleCaseMethod(e.method)}`,
        ...(refLine(e.bankReference, e.receiptRef) ? { line2: refLine(e.bankReference, e.receiptRef)! } : {}),
        payment: -e.amount,
        balance,
      });
    } else {
      balance -= e.amount;
      totalPaid += e.amount;
      kinds.push("payment");
      rows.push({
        date: formatDateDMY(e.effectiveDate),
        line1: `Payment received, ${toTitleCaseMethod(e.method)}`,
        ...(refLine(e.bankReference, e.receiptRef) ? { line2: refLine(e.bankReference, e.receiptRef)! } : {}),
        payment: e.amount,
        balance,
      });
    }
  }

  const closing = balance;
  const summary = { contractPrice: totalCharges, totalPaid, outstanding: closing };

  // Invariants: failures render a red banner on drafts and BLOCK Generate.
  // The first-row guard fires only when no charge entries exist at all
  // (genuinely missing opening — e.g. backfill never ran); charges always
  // lead the statement, so a backdated payment can never trip it.
  const dataCheckErrors: string[] = [];
  if (rows.length === 0 || kinds[0] !== "charge") {
    dataCheckErrors.push("First row is not the contract price charge.");
  }
  if (!creditExists && rows.some((r) => r.balance < 0)) {
    dataCheckErrors.push("Running balance goes negative with no explicit credit.");
  }
  rows.forEach((r, i) => {
    if (i > 0 && r.payment !== undefined && r.payment > 0 && r.balance > rows[i - 1].balance) {
      dataCheckErrors.push(`Balance increases after the payment on ${r.date}.`);
    }
  });
  if (totalCharges - totalPaid !== closing) {
    dataCheckErrors.push("Charges minus payments does not equal the closing balance.");
  }

  // Warnings: Generate shows them with an "Issue anyway" tick (audit-logged).
  const warnings: string[] = [];
  if (contractAssumed) {
    warnings.push(
      `Contract date assumed (${formatDateDMY(contractDateUsed)}${datedPayments.length > 0 ? ", earliest recorded payment" : ""}) — set the real sale date.`
    );
  }
  const effectiveIds = new Set(entries.map((e) => e.paymentId).filter((v): v is string => !!v));
  const unmatched = confirmed.filter(
    (p) => effectiveIds.has(p.id) && !verifiedByPayment.get(p.id)?.includes("Reconciled:")
  ).length;
  if (unmatched > 0) {
    warnings.push(`${unmatched} payment${unmatched === 1 ? "" : "s"} not ticked against the bank statement.`);
  }
  const pending = payments.filter((p) => p.status === "PENDING_VERIFICATION").length;
  if (pending > 0) {
    warnings.push(`${pending} payment${pending === 1 ? "" : "s"} awaiting verification.`);
  }

  return {
    isDraft: opts.draft,
    ...(opts.draft ? {} : { number: opts.number }),
    accountRef: txn.ref,
    generatedOn: formatDateDMY(now),
    asOf: formatDateDMY(asOfDate),
    company: {
      name: COMPANY.name,
      addressLine: COMPANY.address,
      website: COMPANY.website,
      email: COMPANY.email,
      phone: COMPANY.phone,
    },
    client: {
      name: formatDisplayName(txn.customerName),
      ...(txn.customerPhone ? { phone: txn.customerPhone } : {}),
      ...(txn.customerEmail ? { email: txn.customerEmail } : {}),
    },
    property: {
      estate: txn.estate,
      unitType: txn.unitType ?? "",
      sku: txn.plotCode ?? "",
      plots: txn.plotQuantity,
    },
    summary,
    rows,
    totals: { charges: totalCharges, payments: totalPaid },
    closing: { balance: closing, settled: closing === 0, credit: closing < 0 },
    layoutVersion: STATEMENT_LAYOUT_VERSION,
    contractDate: formatDateDMY(contractDateUsed),
    contractAssumed,
    dataCheckErrors,
    warnings,
  };
}

// Lagos day key for statement-day comparisons (re-exported for callers that
// must not touch server-local dates).
export { lagosDayKey };
