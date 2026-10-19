import { describe, it, expect, vi } from "vitest";
import { PDFParse } from "pdf-parse";

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u1", name: "Admin", email: "admin@x.com", role: "admin" } }),
}));

// Mirror of the live TXN-2026-41848 shape that exposed the ordering bug:
// the sale was created 30 Sep 11:15 but the payment is dated 30 Sep 00:00.
// Same display date — the sale must still print before the payment, and the
// company balance must never dip negative in between.
const TXNS = [
  {
    id: "t-live",
    ref: "TXN-2026-41848",
    customerName: "Daniel Ifenna",
    customerEmail: "daniel@example.com",
    estate: "Belgrove Peninsula",
    plotCode: "PEN-250SQM",
    unitType: "4-Bed Semi-Detached Duplex",
    totalPayable: 19_400_000,
    outstandingBalance: 9_700_000,
    status: "ACTIVE",
    contractDate: null,
    createdAt: new Date("2026-09-30T11:15:52Z"),
  },
];

const ENTRIES = [
  {
    id: "le-base",
    transactionId: "t-live",
    type: "CHARGE_BASE",
    amount: 19_400_000,
    direction: "DEBIT",
    effectiveDate: new Date("2026-09-30T11:15:52Z"),
    createdAt: new Date("2026-09-30T11:15:52Z"),
    method: null,
    bankReference: null,
    paymentId: null,
    note: null,
    reversesEntryId: null,
    payment: null,
  },
  {
    id: "le-pay",
    transactionId: "t-live",
    type: "PAYMENT",
    amount: 9_700_000,
    direction: "CREDIT",
    effectiveDate: new Date("2026-09-30T00:00:00Z"),
    createdAt: new Date("2026-09-30T11:24:47Z"),
    method: "Bank Transfer",
    bankReference: null,
    paymentId: "p-live-1",
    note: null,
    reversesEntryId: null,
    payment: { paymentReference: "PAY-2026-64853" },
  },
];

const RECEIPTS = [{ transactionId: "t-live", paymentId: "p-live-1", ref: "RCT-2026-52447" }];
const PAYMENTS = [
  {
    id: "p-live-1",
    transactionId: "t-live",
    status: "CONFIRMED",
    amount: 9_700_000,
    paymentDate: new Date("2026-09-30T00:00:00Z"),
    paymentMethod: "Bank Transfer",
  },
];

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

describe("ledger same-day sale-before-payment", () => {
  it("prints the 19.4M debit before the 9.7M credit, one landscape page, no negatives", async () => {
    const res = await exportLedger(new NextRequest("http://localhost/api/admin/transactions/ledger"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    const buf = Buffer.from(await res.arrayBuffer());

    // Landscape A4: a single MediaBox, wider than tall.
    const boxes = buf.toString("latin1").match(/\/MediaBox\s*\[([\d. ]+)\]/g) ?? [];
    const dims = boxes[0]!.match(/[\d.]+/g)!.map(Number);
    expect(dims[2] - dims[0]).toBeGreaterThan(dims[3] - dims[1]);

    const parser = new PDFParse({ data: buf });
    const { text: raw } = await parser.getText();
    await parser.destroy();
    const text = raw.replace(/\u00A0/g, " ").replace(/\s+/g, " ");

    // Header and legend.
    expect(text).toContain("COMPANY SALES LEDGER");
    expect(text).toContain("Debit: a sale recorded (client owes)");
    expect(text).toContain("Credit: a payment received");

    // No period given → no brought-forward row.
    expect(text).not.toContain("Balance brought forward");

    // Debit before credit despite the 00:00 payment instant predating the
    // 11:15 creation instant on the same display date.
    const debitIdx = text.indexOf("19,400,000");
    const creditIdx = text.indexOf("PAY-2026-64853");
    expect(debitIdx).toBeGreaterThan(-1);
    expect(creditIdx).toBeGreaterThan(-1);
    expect(debitIdx).toBeLessThan(creditIdx);

    // Money is naira, never NGN, and never negative from an ordering error.
    expect(text).toContain("₦");
    expect(text).not.toContain("NGN");
    expect(text).not.toContain("-₦");

    // Credit row carries both refs; closing owed equals the outstanding.
    expect(text).toContain("RCT-2026-52447");
    expect(text).toContain("9,700,000");
  }, 30000);
});
