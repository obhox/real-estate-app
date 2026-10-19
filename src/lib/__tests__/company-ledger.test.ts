import { describe, it, expect } from "vitest";
import {
  buildCompanyLedgerModel,
  type CompanyLedgerTxn,
} from "../company-ledger";
import { lagosToUtc } from "../time";

// Corrected golden fixture (Part 3 of the brief). Three transactions, with
// Valentine's two payments corrected to 3,000,000 each and every sale dated
// from the earliest confirmed payment where no contract date was ever set:
//   TXN-2026-62831 Valentine  18,500,000  → 12,000,000 paid (6,500,000 left)
//   TXN-2026-96894 Sandra      5,625,000  → paid in full
//   TXN-2026-89439 Azubuike    5,800,000  → paid in full
// Expected closing: debit 29,925,000 − credit 23,425,000 = 6,500,000 owed.

const NOW = new Date("2026-10-15T10:00:00Z");

function txn(over: Partial<CompanyLedgerTxn> & Pick<CompanyLedgerTxn, "id" | "ref" | "customerName">): CompanyLedgerTxn {
  return {
    estate: "Sunrise Estate",
    plotCode: "SUN-P1-500SQM",
    unitType: "4-Bed Semi-Detached Duplex",
    totalPayable: 0,
    outstandingBalance: 0,
    status: "ACTIVE",
    contractDate: null,
    createdAt: new Date("2026-10-07T09:00:00Z"),
    ...over,
  };
}

// A CHARGE_BASE entry exists per transaction, dated at creation — the model
// must re-date it to the sale date rather than trust the entry's own date.
function charge(id: string, transactionId: string, amount: number, createdAt: string) {
  return {
    id,
    transactionId,
    type: "CHARGE_BASE",
    amount,
    direction: "DEBIT",
    effectiveDate: new Date(createdAt),
    createdAt: new Date(createdAt),
    method: null,
    bankReference: null,
    paymentId: null,
    note: null,
    reversesEntryId: null,
    payment: null,
  };
}

function payment(opts: {
  id: string;
  transactionId: string;
  amount: number;
  date: string;
  ref: string;
  receipt?: string;
  createdAt?: string;
}) {
  return {
    id: opts.id,
    transactionId: opts.transactionId,
    type: "PAYMENT",
    amount: opts.amount,
    direction: "CREDIT",
    effectiveDate: new Date(`${opts.date}T00:00:00Z`),
    createdAt: new Date(opts.createdAt ?? `${opts.date}T10:00:00Z`),
    method: "Bank Transfer",
    bankReference: null,
    paymentId: opts.id,
    note: null,
    reversesEntryId: null,
    payment: { paymentReference: opts.ref },
  };
}

const VALENTINE = "t-valentine";
const SANDRA = "t-sandra";
const AZUBUIKE = "t-azubuike";

const TXNS: CompanyLedgerTxn[] = [
  txn({
    id: VALENTINE,
    ref: "TXN-2026-62831",
    customerName: "Valentine Nzube Onweluzo",
    totalPayable: 18_500_000,
    outstandingBalance: 6_500_000,
    createdAt: new Date("2026-10-09T09:00:00Z"),
  }),
  txn({
    id: SANDRA,
    ref: "TXN-2026-96894",
    customerName: "SANDRA MBEYI",
    estate: "Belgrove Peninsula",
    plotCode: "PEN-250SQM",
    unitType: "3-Bedroom Terrace Duplex",
    totalPayable: 5_625_000,
    outstandingBalance: 0,
    status: "PAID_IN_FULL",
    createdAt: new Date("2026-10-13T09:00:00Z"),
  }),
  txn({
    id: AZUBUIKE,
    ref: "TXN-2026-89439",
    customerName: "Azubuike Nnamdi Mac Anthony",
    estate: "Belgrove Peninsula",
    plotCode: "PEN-300SQM",
    unitType: "Plot",
    totalPayable: 5_800_000,
    outstandingBalance: 0,
    status: "PAID_IN_FULL",
    createdAt: new Date("2026-10-07T09:00:00Z"),
  }),
];

const ENTRIES = [
  charge("le-v", VALENTINE, 18_500_000, "2026-10-09T09:00:00Z"),
  charge("le-s", SANDRA, 5_625_000, "2026-10-13T09:00:00Z"),
  charge("le-a", AZUBUIKE, 5_800_000, "2026-10-07T09:00:00Z"),
  payment({ id: "le-v1", transactionId: VALENTINE, amount: 3_000_000, date: "2026-08-09", ref: "PAY-18756" }),
  payment({ id: "le-v2", transactionId: VALENTINE, amount: 3_000_000, date: "2026-08-12", ref: "PAY-87544" }),
  payment({ id: "le-v3", transactionId: VALENTINE, amount: 3_000_000, date: "2026-08-19", ref: "PAY-71254" }),
  payment({ id: "le-v4", transactionId: VALENTINE, amount: 3_000_000, date: "2026-09-24", ref: "PAY-18810" }),
  payment({ id: "le-s1", transactionId: SANDRA, amount: 2_812_000, date: "2026-08-13", ref: "PAY-58673" }),
  payment({ id: "le-s2", transactionId: SANDRA, amount: 1_000_000, date: "2026-09-08", ref: "PAY-93694" }),
  payment({ id: "le-s3", transactionId: SANDRA, amount: 1_000_000, date: "2026-09-25", ref: "PAY-26635" }),
  payment({ id: "le-s4", transactionId: SANDRA, amount: 813_000, date: "2026-10-09", ref: "PAY-33838" }),
  payment({ id: "le-a1", transactionId: AZUBUIKE, amount: 5_800_000, date: "2026-10-07", ref: "PAY-43298" }),
];

const RECEIPTS = ENTRIES.filter((e) => e.type === "PAYMENT").map((e) => ({
  transactionId: e.transactionId,
  paymentId: e.id,
  ref: `RCT-${e.id}`,
}));

const PAYMENTS = ENTRIES.filter((e) => e.type === "PAYMENT").map((e) => ({
  id: e.id,
  transactionId: e.transactionId,
  status: "CONFIRMED",
  amount: e.amount,
  paymentDate: e.effectiveDate,
  paymentMethod: "Bank Transfer",
}));

function fakeDb(data: { entries?: unknown[]; receipts?: unknown[]; payments?: unknown[] } = {}) {
  return {
    ledgerEntry: { findMany: async () => data.entries ?? ENTRIES },
    receipt: { findMany: async () => data.receipts ?? RECEIPTS },
    payment: { findMany: async () => data.payments ?? PAYMENTS },
  } as never;
}

async function build(over: Partial<Parameters<typeof buildCompanyLedgerModel>[1]> = {}) {
  return buildCompanyLedgerModel(fakeDb(), { transactions: TXNS, now: NOW, ...over });
}

// [date, entry, debit, credit, accountBalance, totalOwed]
const GOLDEN: [string, string, number | null, number | null, number, number][] = [
  ["09-08-2026", "Sale", 18_500_000, null, 18_500_000, 18_500_000],
  ["09-08-2026", "Payment, Bank Transfer", null, 3_000_000, 15_500_000, 15_500_000],
  ["12-08-2026", "Payment, Bank Transfer", null, 3_000_000, 12_500_000, 12_500_000],
  ["13-08-2026", "Sale", 5_625_000, null, 5_625_000, 18_125_000],
  ["13-08-2026", "Payment, Bank Transfer", null, 2_812_000, 2_813_000, 15_313_000],
  ["19-08-2026", "Payment, Bank Transfer", null, 3_000_000, 9_500_000, 12_313_000],
  ["08-09-2026", "Payment, Bank Transfer", null, 1_000_000, 1_813_000, 11_313_000],
  ["24-09-2026", "Payment, Bank Transfer", null, 3_000_000, 6_500_000, 8_313_000],
  ["25-09-2026", "Payment, Bank Transfer", null, 1_000_000, 813_000, 7_313_000],
  ["07-10-2026", "Sale", 5_800_000, null, 5_800_000, 13_113_000],
  ["07-10-2026", "Payment, Bank Transfer", null, 5_800_000, 0, 7_313_000],
  ["09-10-2026", "Payment, Bank Transfer", null, 813_000, 0, 6_500_000],
];

describe("company ledger — corrected golden fixture", () => {
  it("reproduces every row exactly", async () => {
    const model = await build();
    const actual = model.rows.map((r) => [r.date, r.entry, r.debit, r.credit, r.accountBalance, r.totalOwed]);
    expect(actual).toEqual(GOLDEN);
  });

  it("opens at zero with no opening row when no period is given", async () => {
    const model = await build();
    expect(model.rows.some((r) => r.isOpening)).toBe(false);
    expect(model.rows[0]!.totalOwed).toBe(model.rows[0]!.debit);
  });

  it("totals: debit 29,925,000, credit 23,425,000, owed 6,500,000", async () => {
    const model = await build();
    expect(model.totals).toEqual({ debit: 29_925_000, credit: 23_425_000, owed: 6_500_000 });
    expect(model.summary).toEqual({ totalSales: 29_925_000, totalReceived: 23_425_000, totalOwed: 6_500_000 });
  });

  it("outstanding by account is sorted and sums to the total owed", async () => {
    const model = await build();
    expect(model.outstandingByAccount).toEqual([
      { accountRef: "TXN-2026-62831", clientName: "Valentine Nzube Onweluzo", contractPrice: 18_500_000, paid: 12_000_000, outstanding: 6_500_000 },
      { accountRef: "TXN-2026-96894", clientName: "Sandra Mbeyi", contractPrice: 5_625_000, paid: 5_625_000, outstanding: 0 },
      { accountRef: "TXN-2026-89439", clientName: "Azubuike Nnamdi Mac Anthony", contractPrice: 5_800_000, paid: 5_800_000, outstanding: 0 },
    ]);
    expect(model.outstandingTotals).toEqual({ contractPrice: 29_925_000, paid: 23_425_000, outstanding: 6_500_000 });
  });

  it("never drives the company balance negative (the reported bug)", async () => {
    const model = await build();
    for (const r of model.rows) expect(r.totalOwed).toBeGreaterThanOrEqual(0);
  });

  it("dates every sale on or before the account's first payment, and prints it first for that account", async () => {
    const model = await build();
    for (const t of TXNS) {
      const accRows = model.rows.filter((r) => r.accountRef === t.ref);
      expect(accRows[0]!.entry).toBe("Sale");
      const saleIdx = model.rows.findIndex((r) => r.accountRef === t.ref);
      const firstPayIdx = model.rows.findIndex((r) => r.accountRef === t.ref && r.credit !== null);
      if (firstPayIdx > -1) expect(saleIdx).toBeLessThan(firstPayIdx);
    }
  });

  it("lists a sale for every non-draft transaction, paid or not", async () => {
    const model = await build();
    for (const t of TXNS) {
      expect(model.rows.some((r) => r.accountRef === t.ref && r.entry === "Sale")).toBe(true);
    }
  });

  it("repeated rows on one day put the sale before its payment", async () => {
    const model = await build();
    const onSameDay = (day: string) => {
      const idx = model.rows.map((r, i) => [r, i] as const).filter(([r]) => r.date === day && r.accountRef === "TXN-2026-62831");
      return idx.map(([, i]) => i);
    };
    const [salePos, payPos] = onSameDay("09-08-2026");
    expect(salePos).toBeDefined();
    expect(payPos).toBeDefined();
    expect(salePos!).toBeLessThan(payPos!);
  });
});

describe("company ledger — period", () => {
  it("carries a brought-forward opening and reaches the same closing", async () => {
    const model = await build({ from: lagosToUtc("2026-09-01") });
    expect(model.rows[0]!.isOpening).toBe(true);
    expect(model.rows[0]!.entry).toBe("Balance brought forward");
    // Owed at end of Aug: 18.5M − 3M − 3M + 5.625M − 2.812M − 3M = 12.313M.
    expect(model.rows[0]!.totalOwed).toBe(12_313_000);
    // Every displayed row is inside the period.
    for (const r of model.rows.slice(1)) expect(r.date >= "01-09-2026" || r.date === "").toBe(true);
    // Same closing as the full ledger.
    expect(model.totals.owed).toBe(6_500_000);
  });

  it("excludes later rows when an upper bound is given", async () => {
    const model = await build({ from: lagosToUtc("2026-09-01"), to: lagosToUtc("2026-09-30") });
    expect(model.totals.owed).toBe(7_313_000);
    expect(model.period).toEqual({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("reports the period in the header", async () => {
    const model = await build({ from: lagosToUtc("2026-09-01"), to: lagosToUtc("2026-09-30") });
    expect(model.asOf).toBe("30-09-2026");
    expect(model.period.from).toBe("2026-09-01");
  });
});

describe("company ledger — toggles", () => {
  const PENDING_ENTRIES = ENTRIES;
  const PENDING_PAYMENTS = [
    ...PAYMENTS,
    {
      id: "p-pending",
      transactionId: VALENTINE,
      status: "PENDING_VERIFICATION",
      amount: 500_000,
      paymentDate: new Date("2026-10-14T00:00:00Z"),
      paymentMethod: "Bank Transfer",
    },
  ];

  it("confirmed-only (default) hides pending payments and warns", async () => {
    const model = await buildCompanyLedgerModel(
      fakeDb({ entries: PENDING_ENTRIES, payments: PENDING_PAYMENTS }),
      { transactions: TXNS, now: NOW }
    );
    expect(model.rows.some((r) => r.pending)).toBe(false);
    expect(model.totals.owed).toBe(6_500_000);
    expect(model.warnings.join(" ")).toMatch(/awaiting verification/i);
  });

  it("shows pending payments greyed and out of balances when confirmedOnly is off", async () => {
    const model = await buildCompanyLedgerModel(
      fakeDb({ entries: PENDING_ENTRIES, payments: PENDING_PAYMENTS }),
      { transactions: TXNS, now: NOW, confirmedOnly: false }
    );
    const pending = model.rows.find((r) => r.pending);
    expect(pending).toBeDefined();
    expect(pending!.accountBalance).toBeNull();
    // Balance unchanged: pending never counts.
    expect(model.totals.owed).toBe(6_500_000);
    expect(model.rows[model.rows.length - 1]!.totalOwed).toBe(6_500_000);
  });

  it("shows reversed entries as greyed corrections and changes no number", async () => {
    const reversed = [
      ...ENTRIES,
      {
        id: "le-rev",
        transactionId: SANDRA,
        type: "REVERSAL",
        amount: 2_812_000,
        direction: "DEBIT",
        effectiveDate: new Date("2026-10-10T00:00:00Z"),
        createdAt: new Date("2026-10-10T00:00:00Z"),
        method: null,
        bankReference: null,
        paymentId: null,
        note: "duplicate",
        reversesEntryId: "le-s1",
        payment: null,
      },
    ];
    const db = () => fakeDb({ entries: reversed, payments: PENDING_PAYMENTS });
    const withCorrections = await buildCompanyLedgerModel(db(), {
      transactions: TXNS,
      now: NOW,
      includeCorrections: true,
    });
    const withoutCorrections = await buildCompanyLedgerModel(db(), {
      transactions: TXNS,
      now: NOW,
    });

    const corrections = withCorrections.rows.filter((r) => r.correction);
    expect(corrections.length).toBe(2); // the reversed payment + the REVERSAL line
    for (const c of corrections) expect(c.accountBalance).toBeNull();

    // The toggle is display-only: every figure is identical with it on or off.
    expect(withCorrections.totals).toEqual(withoutCorrections.totals);
    expect(withCorrections.summary).toEqual(withoutCorrections.summary);
    expect(withCorrections.outstandingByAccount).toEqual(withoutCorrections.outstandingByAccount);
    expect(withCorrections.rows.at(-1)!.totalOwed).toBe(withCorrections.totals.owed);

    // A reversal is a real un-payment: Sandra's 2.812M no longer counts, so the
    // company is owed that much more. The corrected total is not 6.5M.
    expect(withCorrections.totals.owed).toBe(9_312_000);
    expect(withCorrections.totals.owed).toBe(withoutCorrections.totals.owed);
  });
});

describe("company ledger — exclusions and fallbacks", () => {
  it("excludes draft/cancelled transactions, counts and warns about them", async () => {
    const model = await buildCompanyLedgerModel(fakeDb(), {
      transactions: [
        ...TXNS,
        txn({ id: "t-cancelled", ref: "TXN-2026-00000", customerName: "Cancelled Buyer", status: "CANCELLED", totalPayable: 9_000_000 }),
      ],
      now: NOW,
    });
    expect(model.accounts).toBe(3);
    expect(model.rows.some((r) => r.accountRef === "TXN-2026-00000")).toBe(false);
    expect(model.warnings.join(" ")).toMatch(/cancelled/i);
    expect(model.totals.owed).toBe(6_500_000);
  });

  it("warns when a transaction has no charge entry and falls back to its payable", async () => {
    const noCharge = {
      ...txn({ id: VALENTINE, ref: "TXN-2026-62831", customerName: "Valentine Nzube Onweluzo", totalPayable: 18_500_000, outstandingBalance: 6_500_000, createdAt: new Date("2026-10-09T09:00:00Z") }),
    };
    const model = await buildCompanyLedgerModel(
      fakeDb({ entries: ENTRIES.filter((e) => e.transactionId !== VALENTINE), payments: PAYMENTS, receipts: RECEIPTS }),
      { transactions: [noCharge], now: NOW }
    );
    expect(model.totals.debit).toBe(18_500_000);
    expect(model.warnings.join(" ")).toMatch(/no charge entry/i);
  });
});
