import { formatDateDMY, lagosDayKey } from "@/lib/time";
import { formatDisplayName } from "@/lib/formatName";
import { COMPANY } from "@/lib/documents/brand";
import {
  orderLedgerEntries,
  selectEffectiveEntries,
  type LedgerEntryRowForEffective,
  type ReceiptRowForEffective,
  type TxClient,
} from "@/lib/finance/ledger";
import { chargeSubtitle } from "@/lib/statement";
import { toTitleCaseMethod } from "@/lib/statement-model";
import { resolveContractDate } from "@/lib/contract-date";

// Company Sales Ledger: every transaction on one sheet — one sale row per
// transaction, then its confirmed payments — with a per-account running
// balance and the company-wide total owed. Read-only: this module derives
// everything from the ledger service and never writes.
//
// Money rules (see the diagnosis): a sale's debit is the sum of the
// transaction's CHARGE_* entries re-dated to the contract date; discounts,
// waivers and downward adjustments read as negative debits; payments as
// credits; refunds as negative credits. Every column is a running sum of
// those signed amounts, so the figures reconcile by construction:
//   Σ debit − Σ credit = total owed = Σ per-account outstanding.
// Corrections (reversed entries and their REVERSAL lines) are shown greyed and
// never counted; pending payments (only when confirmedOnly is off) likewise.

export const COMPANY_LEDGER_LAYOUT_VERSION = "co-ledger-v1";

export type CompanyLedgerRowKind =
  | "sale"
  | "payment"
  | "refund"
  | "discount"
  | "adjustment"
  | "correction"
  | "pending";

export type CompanyLedgerRow = {
  date: string; // dd-mm-yyyy, Africa/Lagos ("" on the opening row)
  accountRef: string;
  clientName: string;
  entry: string;
  reference: string;
  debit: number | null;
  credit: number | null;
  accountBalance: number | null; // this account's owed after this row
  totalOwed: number; // every account's owed after this row
  correction: boolean; // greyed, excluded from balances
  pending: boolean; // greyed, excluded from balances
  isOpening: boolean; // "Balance brought forward"
};

export type CompanyLedgerOutstandingRow = {
  accountRef: string;
  clientName: string;
  contractPrice: number;
  paid: number;
  outstanding: number;
};

export type CompanyLedgerModel = {
  layoutVersion: string;
  company: { name: string; addressLine: string; website: string; email: string; phone: string };
  generatedOn: string;
  asOf: string;
  period: { from: string | null; to: string | null };
  confirmedOnly: boolean;
  includeCorrections: boolean;
  accounts: number;
  rowCount: number;
  rows: CompanyLedgerRow[];
  totals: { debit: number; credit: number; owed: number };
  summary: { totalSales: number; totalReceived: number; totalOwed: number };
  outstandingByAccount: CompanyLedgerOutstandingRow[];
  outstandingTotals: { contractPrice: number; paid: number; outstanding: number };
  warnings: string[];
};

// The transaction fields the model reads. The route selects exactly these.
export type CompanyLedgerTxn = {
  id: string;
  ref: string;
  customerName: string;
  estate: string;
  plotCode: string | null;
  unitType: string | null;
  totalPayable: number;
  outstandingBalance: number;
  status: string;
  contractDate: Date | null;
  createdAt: Date;
};

export type BuildCompanyLedgerOptions = {
  transactions: CompanyLedgerTxn[];
  from?: Date | null;
  to?: Date | null; // inclusive day
  includeCorrections?: boolean;
  confirmedOnly?: boolean;
  now?: Date;
};

// Only needs the ledger service's readers; the route passes `prisma`.
export type CompanyLedgerDb = TxClient;

type EntryRow = LedgerEntryRowForEffective & { transactionId: string };
type ReceiptRow = ReceiptRowForEffective & { transactionId: string };
type PaymentRow = {
  id: string;
  status: string;
  amount: number;
  paymentDate: Date;
  paymentMethod: string | null;
};

type WorkingRow = {
  id: string;
  type: string; // ledger type, for the shared ordering rule
  effectiveDate: Date;
  createdAt: Date;
  txnId: string;
  debit: number | null;
  credit: number | null;
  entry: string;
  reference: string;
  correction: boolean;
  pending: boolean;
};

const EXCLUDED_STATUSES = new Set(["DRAFT", "CANCELLED"]);

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

// "PAY-... · RCT-... · <bank ref>", segments omitted when missing.
type ReferenceSource = {
  paymentReference?: string | null;
  receiptRef?: string | null;
  bankReference?: string | null;
};

function refLine(parts: (string | null | undefined)[]): string {
  return parts.filter((s): s is string => !!s && s.trim() !== "").join(" · ");
}

function paymentReferenceLine(e: ReferenceSource): string {
  return refLine([e.paymentReference, e.receiptRef, e.bankReference]);
}

// The same line for a raw entry row, whose payment/receipt refs live on the
// joined relation and the receipt lookup rather than flattened fields.
function rawReferenceLine(
  e: EntryRow,
  receiptRefByPaymentId: Map<string, string>
): string {
  return refLine([
    e.payment?.paymentReference ?? null,
    e.paymentId ? (receiptRefByPaymentId.get(e.paymentId) ?? null) : null,
    e.bankReference,
  ]);
}

function describeCorrection(e: EntryRow, original: EntryRow | undefined): string {
  const subject = original ?? e;
  if (subject.type === "PAYMENT") return "Correction: payment reversed";
  if (subject.type.startsWith("CHARGE")) return "Correction: charge reversed";
  return "Correction: entry reversed";
}

export async function buildCompanyLedgerModel(
  db: CompanyLedgerDb,
  opts: BuildCompanyLedgerOptions
): Promise<CompanyLedgerModel> {
  const now = opts.now ?? new Date();
  const confirmedOnly = opts.confirmedOnly ?? true;
  const includeCorrections = opts.includeCorrections ?? false;
  const warnings: string[] = [];

  const excluded = opts.transactions.filter((t) => EXCLUDED_STATUSES.has(t.status));
  const txns = opts.transactions.filter((t) => !EXCLUDED_STATUSES.has(t.status));
  const ids = txns.map((t) => t.id);

  let entryRows: EntryRow[] = [];
  let receiptRows: ReceiptRow[] = [];
  let paymentRows: (PaymentRow & { transactionId: string })[] = [];
  if (ids.length > 0) {
    const [entries, receipts, payments] = await Promise.all([
      db.ledgerEntry.findMany({
        where: { transactionId: { in: ids } },
        include: { payment: { select: { paymentReference: true } } },
      }),
      db.receipt.findMany({
        where: { transactionId: { in: ids } },
        select: { transactionId: true, paymentId: true, ref: true },
      }),
      db.payment.findMany({
        where: { transactionId: { in: ids } },
        select: {
          id: true,
          transactionId: true,
          status: true,
          amount: true,
          paymentDate: true,
          paymentMethod: true,
        },
      }),
    ]);
    entryRows = entries as EntryRow[];
    receiptRows = receipts as ReceiptRow[];
    paymentRows = payments as (PaymentRow & { transactionId: string })[];
  }

  const entriesByTxn = groupBy(entryRows, (e) => e.transactionId);
  const receiptsByTxn = groupBy(receiptRows, (r) => r.transactionId);
  const receiptRefByPaymentId = new Map(
    receiptRows.filter((r) => r.paymentId).map((r) => [r.paymentId as string, r.ref])
  );
  const paymentsByTxn = groupBy(paymentRows, (p) => p.transactionId);

  const txnById = new Map(txns.map((t) => [t.id, t]));
  const working: WorkingRow[] = [];
  let assumedDates = 0;
  let missingCharges = 0;
  let pendingCount = 0;

  for (const t of txns) {
    const txnEntries = entriesByTxn.get(t.id) ?? [];
    const txnReceipts = receiptsByTxn.get(t.id) ?? [];
    const txnPayments = paymentsByTxn.get(t.id) ?? [];

    const resolved = resolveContractDate(
      { contractDate: t.contractDate, createdAt: t.createdAt },
      txnPayments.map((p) => ({ status: p.status, paymentDate: p.paymentDate })),
      { includePending: false, detectCreationArtifact: true }
    );
    if (resolved.assumed) assumedDates++;

    const property = chargeSubtitle(t.estate, t.plotCode) ?? t.estate;
    const effective = selectEffectiveEntries(txnEntries, txnReceipts);
    const charges = effective.filter((e) => e.type.startsWith("CHARGE"));

    if (charges.length > 0) {
      working.push({
        id: `sale:${t.id}`,
        type: "CHARGE_BASE",
        effectiveDate: resolved.date,
        createdAt: t.createdAt,
        txnId: t.id,
        debit: charges.reduce((s, e) => s + e.amount, 0),
        credit: null,
        entry: "Sale",
        reference: property,
        correction: false,
        pending: false,
      });
    } else if (t.totalPayable > 0) {
      // Ledger has no CHARGE entry for this transaction (backfill never ran):
      // fall back to the stored payable so the sale is never silently hidden.
      missingCharges++;
      working.push({
        id: `sale-fallback:${t.id}`,
        type: "CHARGE_BASE",
        effectiveDate: resolved.date,
        createdAt: t.createdAt,
        txnId: t.id,
        debit: t.totalPayable,
        credit: null,
        entry: "Sale",
        reference: property,
        correction: false,
        pending: false,
      });
    }

    for (const e of effective) {
      if (e.type.startsWith("CHARGE")) continue;
      const date = new Date(e.effectiveDate);
      if (e.type === "DISCOUNT" || e.type === "WAIVER") {
        working.push({
          id: e.id,
          type: e.type,
          effectiveDate: date,
          createdAt: e.createdAt,
          txnId: t.id,
          debit: -e.amount,
          credit: null,
          entry: e.type === "DISCOUNT" ? "Discount" : "Waiver",
          reference: property,
          correction: false,
          pending: false,
        });
      } else if (e.type === "ADJUSTMENT") {
        const downward = e.direction !== "DEBIT";
        working.push({
          id: e.id,
          type: e.type,
          effectiveDate: date,
          createdAt: e.createdAt,
          txnId: t.id,
          debit: downward ? -e.amount : e.amount,
          credit: null,
          entry: e.note ? `Adjustment — ${e.note}` : "Adjustment",
          reference: property,
          correction: false,
          pending: false,
        });
      } else if (e.type === "REFUND" || (e.type === "PAYMENT" && e.direction === "DEBIT")) {
        working.push({
          id: e.id,
          type: "REFUND",
          effectiveDate: date,
          createdAt: e.createdAt,
          txnId: t.id,
          debit: null,
          credit: -e.amount,
          entry: `Refund, ${toTitleCaseMethod(e.method)}`,
          reference: paymentReferenceLine(e),
          correction: false,
          pending: false,
        });
      } else {
        working.push({
          id: e.id,
          type: "PAYMENT",
          effectiveDate: date,
          createdAt: e.createdAt,
          txnId: t.id,
          debit: null,
          credit: e.amount,
          entry: `Payment, ${toTitleCaseMethod(e.method)}`,
          reference: paymentReferenceLine(e),
          correction: false,
          pending: false,
        });
      }
    }

    if (includeCorrections) {
      const byId = new Map(txnEntries.map((e) => [e.id, e]));
      const reversedIds = new Set(
        txnEntries
          .filter((e) => e.type === "REVERSAL" && e.reversesEntryId)
          .map((e) => e.reversesEntryId as string)
      );
      for (const e of txnEntries) {
        const isReversal = e.type === "REVERSAL";
        if (!isReversal && !reversedIds.has(e.id)) continue;
        const original = isReversal && e.reversesEntryId ? byId.get(e.reversesEntryId) : undefined;
        const subject = original ?? e;
        const isPaymentish = subject.type === "PAYMENT" || subject.type === "REFUND";
        let debit: number | null = null;
        let credit: number | null = null;
        if (isReversal) {
          // A reversal puts money back on the account (payment) or removes a
          // charge; excluded from balances either way.
          if (isPaymentish) credit = -e.amount;
          else debit = -e.amount;
        } else if (subject.direction === "CREDIT") {
          credit = subject.amount;
        } else {
          debit = subject.amount;
        }
        working.push({
          id: `correction:${e.id}`,
          type: "REVERSAL",
          effectiveDate: new Date(e.effectiveDate),
          createdAt: e.createdAt,
          txnId: t.id,
          debit,
          credit,
          entry: isReversal ? describeCorrection(e, original) : `Reversed: ${subject.type}`,
          reference: rawReferenceLine(subject, receiptRefByPaymentId),
          correction: true,
          pending: false,
        });
      }
    }

    if (!confirmedOnly) {
      for (const p of txnPayments) {
        if (p.status !== "PENDING_VERIFICATION") continue;
        pendingCount++;
        working.push({
          id: `pending:${p.id}`,
          type: "PAYMENT",
          effectiveDate: new Date(p.paymentDate),
          createdAt: new Date(p.paymentDate),
          txnId: t.id,
          debit: null,
          credit: p.amount,
          entry: `Payment (pending), ${toTitleCaseMethod(p.paymentMethod)}`,
          reference: "Awaiting verification",
          correction: false,
          pending: true,
        });
      }
    }
  }

  // One shared ordering pass, then one running balance — nothing downstream
  // recomputes a total.
  const ordered = orderLedgerEntries(working);
  const accountBalance = new Map<string, number>();
  let totalOwed = 0;
  const withRunning = ordered.map((r) => {
    if (r.correction || r.pending) {
      return { ...r, accountBalance: accountBalance.get(r.txnId) ?? 0, totalOwed };
    }
    const delta = (r.debit ?? 0) - (r.credit ?? 0);
    totalOwed += delta;
    accountBalance.set(r.txnId, (accountBalance.get(r.txnId) ?? 0) + delta);
    return { ...r, accountBalance: accountBalance.get(r.txnId) ?? 0, totalOwed };
  });
  const allTimeOwed = totalOwed;

  const fromDay = opts.from ? lagosDayKey(opts.from) : null;
  const toDay = opts.to ? lagosDayKey(opts.to) : null;
  const inPeriod = (d: Date) => {
    const k = lagosDayKey(d);
    if (fromDay && k < fromDay) return false;
    if (toDay && k > toDay) return false;
    return true;
  };

  let opening = 0;
  if (fromDay) {
    const before = withRunning.filter((r) => lagosDayKey(r.effectiveDate) < fromDay);
    opening = before.length > 0 ? before[before.length - 1].totalOwed : 0;
  }

  const displayed = withRunning.filter((r) => inPeriod(r.effectiveDate));

  const rows: CompanyLedgerRow[] = [];
  if (fromDay) {
    rows.push({
      date: "",
      accountRef: "",
      clientName: "",
      entry: "Balance brought forward",
      reference: "",
      debit: null,
      credit: null,
      accountBalance: null,
      totalOwed: opening,
      correction: false,
      pending: false,
      isOpening: true,
    });
  }
  for (const r of displayed) {
    const t = txnById.get(r.txnId);
    rows.push({
      date: formatDateDMY(r.effectiveDate),
      accountRef: t?.ref ?? "",
      clientName: t ? formatDisplayName(t.customerName) : "",
      entry: r.entry,
      reference: r.reference,
      debit: r.debit,
      credit: r.credit,
      accountBalance: r.correction || r.pending ? null : r.accountBalance,
      totalOwed: r.totalOwed,
      correction: r.correction,
      pending: r.pending,
      isOpening: false,
    });
  }

  const counted = displayed.filter((r) => !r.correction && !r.pending);
  const debitTotal = counted.reduce((s, r) => s + (r.debit ?? 0), 0);
  const creditTotal = counted.reduce((s, r) => s + (r.credit ?? 0), 0);
  const owedAtEnd = displayed.length > 0 ? displayed[displayed.length - 1].totalOwed : opening;

  const outstandingByAccount: CompanyLedgerOutstandingRow[] = [];
  let storedMismatch = 0;
  for (const t of txns) {
    const accRows = withRunning.filter((r) => r.txnId === t.id && !r.correction && !r.pending);
    const contractPrice = accRows.reduce((s, r) => s + (r.debit ?? 0), 0);
    const paid = accRows.reduce((s, r) => s + (r.credit ?? 0), 0);
    const outstanding = contractPrice - paid;
    if (outstanding !== t.outstandingBalance) storedMismatch++;
    outstandingByAccount.push({
      accountRef: t.ref,
      clientName: formatDisplayName(t.customerName),
      contractPrice,
      paid,
      outstanding,
    });
  }
  outstandingByAccount.sort((a, b) => b.outstanding - a.outstanding);
  const outstandingTotals = {
    contractPrice: outstandingByAccount.reduce((s, r) => s + r.contractPrice, 0),
    paid: outstandingByAccount.reduce((s, r) => s + r.paid, 0),
    outstanding: outstandingByAccount.reduce((s, r) => s + r.outstanding, 0),
  };

  const sumOutstanding = outstandingTotals.outstanding;
  if (sumOutstanding !== allTimeOwed) {
    warnings.push(
      `Ledger total owed (${allTimeOwed}) does not equal the sum of account balances (${sumOutstanding}).`
    );
  }
  if (storedMismatch > 0) {
    warnings.push(
      `${storedMismatch} account${storedMismatch === 1 ? "" : "s"} disagree with the stored outstanding balance.`
    );
  }
  if (excluded.length > 0) {
    warnings.push(
      `${excluded.length} draft or cancelled transaction${excluded.length === 1 ? "" : "s"} excluded.`
    );
  }
  if (assumedDates > 0) {
    warnings.push(
      `${assumedDates} transaction${assumedDates === 1 ? "" : "s"} dated by earliest payment or creation — set the real sale date.`
    );
  }
  if (missingCharges > 0) {
    warnings.push(
      `${missingCharges} transaction${missingCharges === 1 ? "" : "s"} had no charge entry; stored payable used.`
    );
  }
  if (confirmedOnly && pendingCount === 0) {
    const pendingAll = paymentRows.filter((p) => p.status === "PENDING_VERIFICATION").length;
    if (pendingAll > 0) {
      warnings.push(
        `${pendingAll} payment${pendingAll === 1 ? "" : "s"} awaiting verification excluded.`
      );
    }
  }

  return {
    layoutVersion: COMPANY_LEDGER_LAYOUT_VERSION,
    company: {
      name: COMPANY.name,
      addressLine: COMPANY.address,
      website: COMPANY.website,
      email: COMPANY.email,
      phone: COMPANY.phone,
    },
    generatedOn: formatDateDMY(now),
    asOf: formatDateDMY(opts.to ?? now),
    period: { from: fromDay, to: toDay },
    confirmedOnly,
    includeCorrections,
    accounts: txns.length,
    rowCount: rows.length,
    rows,
    totals: { debit: debitTotal, credit: creditTotal, owed: owedAtEnd },
    summary: { totalSales: debitTotal, totalReceived: creditTotal, totalOwed: owedAtEnd },
    outstandingByAccount,
    outstandingTotals,
    warnings,
  };
}
