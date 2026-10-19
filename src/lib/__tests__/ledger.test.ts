import { describe, it, expect, vi } from "vitest";
import { PDFParse } from "pdf-parse";

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u1", name: "Admin", email: "admin@x.com", role: "admin" } }),
}));

// Company ledger fixture: 3 transactions across 2 customers.
// A1: 10M sale, 4M paid 05 Sep, 6M paid 20 Sep (fully paid).
// B1: 8M sale, 3M paid 04 Sep (5M outstanding).
// A2: 5M sale 10 Sep, unpaid (5M outstanding).
// No contract date was ever set, so each sale is dated from the account's
// earliest confirmed payment: A1 → 05 Sep, B1 → 04 Sep, A2 → its creation.
// Total outstanding = 0 + 5M + 5M = 10M.
const TXNS = [
  {
    id: "t-a1",
    ref: "TXN-2026-00011",
    customerName: "Adaeze Okonkwo",
    estate: "Belgrove Peninsula",
    plotCode: "PEN-A1",
    unitType: "4-Bed Semi-Detached Duplex",
    totalPayable: 10_000_000,
    outstandingBalance: 0,
    status: "PAID_IN_FULL",
    contractDate: null,
    createdAt: new Date("2026-09-01T09:00:00Z"),
  },
  {
    id: "t-b1",
    ref: "TXN-2026-00012",
    customerName: "Chidi Eze",
    estate: "Belgrove Peninsula",
    plotCode: "PEN-B1",
    unitType: "3-Bedroom Terrace Duplex",
    totalPayable: 8_000_000,
    outstandingBalance: 5_000_000,
    status: "ACTIVE",
    contractDate: null,
    createdAt: new Date("2026-09-03T09:00:00Z"),
  },
  {
    id: "t-a2",
    ref: "TXN-2026-00013",
    customerName: "Adaeze Okonkwo",
    estate: "Belgrove Peninsula",
    plotCode: "PEN-A2",
    unitType: "Plot",
    totalPayable: 5_000_000,
    outstandingBalance: 5_000_000,
    status: "ACTIVE",
    contractDate: null,
    createdAt: new Date("2026-09-10T09:00:00Z"),
  },
];

function charge(id: string, transactionId: string, amount: number, at: string) {
  return {
    id,
    transactionId,
    type: "CHARGE_BASE",
    amount,
    direction: "DEBIT",
    effectiveDate: new Date(at),
    createdAt: new Date(at),
    method: null,
    bankReference: null,
    paymentId: null,
    note: null,
    reversesEntryId: null,
    payment: null,
  };
}

function payment(id: string, transactionId: string, amount: number, date: string, ref: string) {
  return {
    id,
    transactionId,
    type: "PAYMENT",
    amount,
    direction: "CREDIT",
    effectiveDate: new Date(`${date}T00:00:00Z`),
    createdAt: new Date(`${date}T10:00:00Z`),
    method: "Bank Transfer",
    bankReference: null,
    paymentId: id,
    note: null,
    reversesEntryId: null,
    payment: { paymentReference: ref },
  };
}

const ENTRIES = [
  charge("le-a1", "t-a1", 10_000_000, "2026-09-01T09:00:00Z"),
  charge("le-b1", "t-b1", 8_000_000, "2026-09-03T09:00:00Z"),
  charge("le-a2", "t-a2", 5_000_000, "2026-09-10T09:00:00Z"),
  payment("le-a1-p1", "t-a1", 4_000_000, "2026-09-05", "PAY-2026-00011"),
  payment("le-a1-p2", "t-a1", 6_000_000, "2026-09-20", "PAY-2026-00012"),
  payment("le-b1-p1", "t-b1", 3_000_000, "2026-09-04", "PAY-2026-00013"),
];

const RECEIPTS = [
  { transactionId: "t-a1", paymentId: "le-a1-p1", ref: "RCT-2026-00011" },
  { transactionId: "t-a1", paymentId: "le-a1-p2", ref: "RCT-2026-00012" },
  { transactionId: "t-b1", paymentId: "le-b1-p1", ref: "RCT-2026-00013" },
];

const PAYMENTS = ENTRIES.filter((e) => e.type === "PAYMENT").map((e) => ({
  id: e.id,
  transactionId: e.transactionId,
  status: "CONFIRMED",
  amount: e.amount,
  paymentDate: e.effectiveDate,
  paymentMethod: "Bank Transfer",
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: { findMany: async () => TXNS },
    ledgerEntry: { findMany: async () => ENTRIES },
    receipt: { findMany: async () => RECEIPTS },
    payment: { findMany: async () => PAYMENTS },
  },
}));

import { NextRequest } from "next/server";
import { GET as exportLedger } from "@/app/api/admin/transactions/ledger/route";

async function ledgerText(url: string): Promise<string> {
  const res = await exportLedger(new NextRequest(url));
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toBe("application/pdf");
  const parser = new PDFParse({ data: Buffer.from(await res.arrayBuffer()) });
  const { text } = await parser.getText();
  await parser.destroy();
  return text.replace(/\u00A0/g, " ").replace(/\s+/g, " ");
}

describe("company ledger export", () => {
  it("lists every transaction chronologically with running balances and a closing equal to total outstanding", async () => {
    const text = await ledgerText("http://localhost/api/admin/transactions/ledger");

    // Header, legend and summary cells.
    expect(text).toContain("COMPANY SALES LEDGER");
    expect(text).toContain("Debit: a sale recorded (client owes)");
    expect(text).toContain("Credit: a payment received");
    expect(text).toContain("TOTAL SALES");
    expect(text).toContain("TOTAL RECEIVED");
    expect(text).toContain("TOTAL OWED TO US");
    expect(text).toContain("Outstanding by account");

    // Credits in chronological order: 04 Sep (B1), 05 Sep (A1), 20 Sep (A1).
    const b1 = text.indexOf("PAY-2026-00013");
    const a1a = text.indexOf("PAY-2026-00011");
    const a1b = text.indexOf("PAY-2026-00012");
    expect(b1).toBeGreaterThan(-1);
    expect(b1).toBeLessThan(a1a);
    expect(a1a).toBeLessThan(a1b);

    // Credit rows carry PAY + receipt refs.
    expect(text).toContain("RCT-2026-00013");
    expect(text).toContain("PAY-2026-00013");

    // Every sale is dated on or before its account's first payment, so B1's
    // sale (04 Sep) precedes its payment, never after it.
    const b1Sale = text.indexOf("PEN-B1");
    expect(b1Sale).toBeGreaterThan(-1);
    expect(b1Sale).toBeLessThan(b1);

    // No period given → no brought-forward row.
    expect(text).not.toContain("Balance brought forward");

    // Running "Total owed to us": 16M after A2's sale, 10M at the close.
    expect(text).toContain("16,000,000");
    expect(text).toContain("10,000,000");

    // Account balances: B1 owes 5M after its payment; A2 owes 5M.
    expect(text).toContain("5,000,000");

    // Totals: 23M debited, 13M credited, 10M owed — and never negative.
    expect(text).toContain("23,000,000");
    expect(text).toContain("13,000,000");
    expect(text).not.toContain("-₦");
    expect(text).not.toContain("NGN");
    expect(text).toContain("₦");
  }, 30000);

  it("a date range compresses earlier rows into a brought-forward opening balance", async () => {
    const text = await ledgerText("http://localhost/api/admin/transactions/ledger?from=2026-09-05");

    // Before 05 Sep: B1's 8M sale and 3M payment → 5M still owed.
    const openingIdx = text.indexOf("Balance brought forward");
    expect(openingIdx).toBeGreaterThan(-1);
    expect(openingIdx).toBeLessThan(text.indexOf("PEN-A1"));

    // Pre-period sale dates are compressed away…
    expect(text).not.toContain("04-09-2026");
    // …but the period's own rows remain.
    expect(text).toContain("05-09-2026");
    expect(text).toContain("PAY-2026-00012");

    // Same closing as the full ledger: the period runs to the end of the data.
    expect(text).toContain("10,000,000");
  }, 30000);

  it("confirmedOnly=0 drops the confirmed-only subtitle instead of silently hiding pending rows", async () => {
    const text = await ledgerText("http://localhost/api/admin/transactions/ledger?confirmedOnly=0");
    expect(text).toContain("COMPANY SALES LEDGER");
    expect(text).not.toContain("CONFIRMED PAYMENTS ONLY");
    // The same figures: the fixture has no pending payments to add.
    expect(text).toContain("23,000,000");
    expect(text).toContain("10,000,000");
  }, 30000);
});
