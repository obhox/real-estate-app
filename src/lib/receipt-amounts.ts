// Single source of truth for the receipt amounts block order and wording.
// Used by the admin receipt page, the client receipt page, and the PDF
// template so all three read: This payment · Installment · Total price ·
// Paid to date · Balance remaining, with Discount only when > 0.
import { formatNaira } from "./currency";

// Installment display label for allocation-derived "Applied to" lines. THE
// replacement for the old rigid schedule labels ("Initial payment" /
// "Month 1" from the payment's single installment link): a payment can span
// several installments via the waterfall, so labels always derive from the
// allocation rows, never from payment.installment.
export function installmentAppliedLabel(installmentNumber: number, type: string): string {
  return type === "INITIAL" || installmentNumber === 0 ? "Initial deposit" : `Month ${installmentNumber}`;
}

export type AppliedToPart = {
  installmentNumber: number;
  type: string;
  amount: number;
  scheduledAmount: number;
};

// "Initial deposit ₦250,000 of ₦9,250,000, Month 1 ₦2,750,000 of ₦3,083,333".
// Shared by Payment History, receipt pages and new receipt PDFs so the three
// can never describe one payment differently.
export function appliedToLabel(parts: AppliedToPart[]): string {
  const ordered = [...parts].sort((a, b) => a.installmentNumber - b.installmentNumber);
  return ordered
    .map((p) => `${installmentAppliedLabel(p.installmentNumber, p.type)} ${formatNaira(p.amount)} of ${formatNaira(p.scheduledAmount)}`)
    .join(", ");
}
export type ReceiptAmountsInput = {
  thisPayment: number;
  installmentLabel?: string | null;
  totalPrice: number;
  // One-time plan interest, shown as a breakdown line under "Total price"
  // (never added again — totalPrice already includes it). Omitted when zero.
  interestAmount?: number | null;
  paidToDate: number;
  balanceRemaining: number;
  discount?: number | null;
};

export type ReceiptAmountsRow = {
  key: "this-payment" | "installment" | "total-price" | "interest" | "paid-to-date" | "balance" | "discount";
  label: string;
  value: number | string;
  emphasize?: boolean;
};

export function receiptAmountsRows(input: ReceiptAmountsInput): ReceiptAmountsRow[] {
  const rows: ReceiptAmountsRow[] = [
    { key: "this-payment", label: "This payment", value: input.thisPayment, emphasize: true },
  ];
  if (input.installmentLabel) {
    rows.push({ key: "installment", label: "Installment", value: input.installmentLabel });
  }
  rows.push({ key: "total-price", label: "Total price", value: input.totalPrice });
  if ((input.interestAmount ?? 0) > 0) {
    rows.push({ key: "interest", label: "Interest", value: input.interestAmount as number });
  }
  rows.push({ key: "paid-to-date", label: "Paid to date", value: input.paidToDate });
  rows.push({ key: "balance", label: "Balance remaining", value: input.balanceRemaining, emphasize: true });
  if ((input.discount ?? 0) > 0) {
    rows.push({ key: "discount", label: "Discount", value: input.discount as number });
  }
  return rows;
}

// Plain-text settlement label (header, no stamp graphic): PART while anything
// is outstanding, FINAL once the balance reaches zero (or credit).
export type SettlementLabel = "PART PAYMENT" | "FINAL PAYMENT, ACCOUNT SETTLED";

export function settlementLabel(balanceAfter: number): SettlementLabel {
  return balanceAfter > 0 ? "PART PAYMENT" : "FINAL PAYMENT, ACCOUNT SETTLED";
}

// Whole months from `from` up to `to` (calendar-month difference), floored at 0.
// Used for the "N months ahead of schedule" settlement wording.
export function monthsAhead(from: Date | string, to: Date | string): number {
  const a = new Date(from);
  const b = new Date(to);
  const diff = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  return diff > 0 ? diff : 0;
}

export type SettlementCopy = {
  settled: boolean;
  headline: SettlementLabel;
  // Client-facing sentence shown when the plan settles early (null otherwise).
  note: string | null;
  monthsAhead: number | null;
};

// Richer client wording than settlementLabel: adds the "plan fully paid on
// <date>, <N> months ahead of schedule / no further payments due" sentence once
// the balance reaches zero. Purely presentational — never affects money.
export function settlementCopy(opts: {
  balanceAfter: number;
  settledOn?: Date | string | null;
  scheduledEnd?: Date | string | null;
  formatDate?: (d: Date | string) => string;
}): SettlementCopy {
  const headline = settlementLabel(opts.balanceAfter);
  if (opts.balanceAfter > 0) {
    return { settled: false, headline, note: null, monthsAhead: null };
  }
  const fmt = opts.formatDate ?? ((d: Date | string) => new Date(d).toISOString().slice(0, 10));
  const paidOn = opts.settledOn ? fmt(opts.settledOn) : null;
  const ahead =
    opts.settledOn && opts.scheduledEnd ? monthsAhead(opts.settledOn, opts.scheduledEnd) : null;
  let note = paidOn ? `Plan fully paid on ${paidOn}.` : "Plan fully paid.";
  if (ahead && ahead > 0) note += ` ${ahead} month${ahead === 1 ? "" : "s"} ahead of schedule.`;
  note += " No further payments due.";
  // null (not 0) when the plan did not finish ahead of schedule, so callers
  // show the "months ahead" clause only when there is one.
  return { settled: true, headline, note, monthsAhead: ahead && ahead > 0 ? ahead : null };
}

export type SettlementLetterContext = {
  clientName: string;
  transactionRef: string;
  totalPaid: number;
  settledOn: Date | string;
  formatDate: (d: Date | string) => string;
  formatMoney: (n: number) => string;
};

// Hook: the single extension point for a settlement letter. Returns plain-text
// letter body for a fully-settled plan, or null when the account is not settled
// (never emit a settlement letter for an outstanding balance).
export function settlementLetter(
  copy: SettlementCopy,
  ctx: SettlementLetterContext
): string | null {
  if (!copy.settled) return null;
  const paid = ctx.formatMoney(ctx.totalPaid);
  return [
    `Dear ${ctx.clientName},`,
    "",
    `We confirm that your payment plan for ${ctx.transactionRef} is fully settled.`,
    `Total paid: ${paid}.`,
    `${copy.note ?? "Plan fully paid. No further payments due."}`,
    `Settled on: ${ctx.formatDate(ctx.settledOn)}.`,
    "",
    "Thank you for your business.",
  ].join("\n");
}

export type HistoryPayment = {
  id: string;
  date: Date | string;
  method: string;
  amount: number;
};

export type ReceiptHistoryRow = {
  index: number;
  date: string;
  method: string;
  amount: number;
  receiptRef: string | null;
  runningBalance: number;
  isCurrent: boolean;
};

// Full payment-history table for a receipt: every confirmed payment up to and
// including this one, oldest first, each with its receipt ref and the running
// balance AFTER that payment. totalPayable anchors the balances.
export function buildReceiptHistory(
  confirmed: HistoryPayment[],
  receiptRefByPaymentId: Map<string, string>,
  currentPaymentId: string,
  totalPayable: number,
  formatDate: (d: Date | string) => string
): ReceiptHistoryRow[] {
  const ordered = [...confirmed].sort((a, b) => {
    const ta = new Date(a.date).getTime();
    const tb = new Date(b.date).getTime();
    return ta - tb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
  let paid = 0;
  const rows: ReceiptHistoryRow[] = [];
  for (const p of ordered) {
    paid += p.amount;
    rows.push({
      index: rows.length + 1,
      date: formatDate(p.date),
      method: p.method,
      amount: p.amount,
      receiptRef: receiptRefByPaymentId.get(p.id) ?? null,
      runningBalance: totalPayable - paid,
      isCurrent: p.id === currentPaymentId,
    });
    if (p.id === currentPaymentId) break;
  }
  return rows;
}

// Account reference line: transaction ref + booking ref (when linked).
// Separate from the receipt number, which stays RCT-….
export function buildAccountRef(txnRef: string, bookingRef: string | null): string {
  return bookingRef ? `${txnRef} · ${bookingRef}` : txnRef;
}
