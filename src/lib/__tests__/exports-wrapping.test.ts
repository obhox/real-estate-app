import { describe, it, expect, vi } from "vitest";
import { PDFParse } from "pdf-parse";
import { wrapLongWords, cleanExportText, TABLE_OVERFLOW_LINEBREAK } from "../documents/exportTables";
import { generateReceiptPdf } from "../receipts/generateReceiptPdf";
import {
  bookingReceivedTemplate,
  adminNewBookingAlertTemplate,
  transactionConfirmationTemplate,
} from "../email/templates";

// Pathological export data: a 120-char unbroken string, a very long email,
// and a multi-line address. Every export must wrap these inside their
// cell/border — never overflow, never silently truncate (truncation with an
// explicit ellipsis is allowed only as a documented last resort).
const UNBROKEN_120 = "Z".repeat(120);
const UNBROKEN_200 = "Q".repeat(200);
const LONG_EMAIL = `${"very.long.local.part.that.keeps.going.and.going.and.going".replaceAll(".", "")}@example.com`;
const LONG_UNBROKEN_EMAIL = `${"e".repeat(150)}@example.com`;
const ADDRESS_3LINE = "Suite 25, Lebrex Plaza\n47 Ajose Adeogun Street\nUtako, Abuja 900108";

// jsPDF emits uncompressed content streams, so rendered text is searchable
// in the raw buffer. Returns the concatenated text literals.
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const literals = raw.match(/\((?:[^()\\]|\\.)*\)/g) ?? [];
  return literals
    .map((l) => l.slice(1, -1).replace(/\\([()\\])/g, "$1"))
    .join("\n");
}

describe("wrapLongWords", () => {
  it("chunks unbroken strings without losing characters", () => {
    const out = wrapLongWords(UNBROKEN_120);
    expect(out.replaceAll("\n", "")).toBe(UNBROKEN_120);
    for (const chunk of out.split("\n")) expect(chunk.length).toBeLessThanOrEqual(40);
  });

  it("leaves normal spaced text and short words untouched", () => {
    expect(wrapLongWords("Downtown Golf Resort Kuje")).toBe("Downtown Golf Resort Kuje");
    expect(wrapLongWords("a@b.com")).toBe("a@b.com");
    expect(wrapLongWords("")).toBe("");
    expect(wrapLongWords(null)).toBe("");
  });

  it("preserves existing line breaks (multi-line addresses)", () => {
    const out = wrapLongWords(ADDRESS_3LINE);
    expect(out.replaceAll("\n", " ").replaceAll("  ", " ").trim().length).toBeGreaterThan(0);
    expect(out.replace(/[\n ]/g, "")).toBe(ADDRESS_3LINE.replace(/[\n ]/g, ""));
  });

  it("the shared autotable overflow is linebreak", () => {
    expect(TABLE_OVERFLOW_LINEBREAK).toBe("linebreak");
  });

  it("normalizes pasted Windows line endings and tabs without losing text", () => {
    expect(cleanExportText("a\r\nb\rc\td")).toBe("a\nb\nc d");
    expect(cleanExportText(null)).toBe("");
    // wrapLongWords on cleaned text still chunks unbroken runs.
    const out = wrapLongWords(cleanExportText(`x\r\n${"W".repeat(100)}`));
    expect(out.replaceAll("\n", "")).toBe(`x${"W".repeat(100)}`);
  });
});

describe("email HTML wrapping", () => {
  const date = new Date("2026-12-15T09:00:00Z");
  it("booking templates keep long emails/locations inside fixed-layout tables", () => {
    const html = bookingReceivedTemplate({
      name: "Test Buyer",
      ref: "BKG-2026-00001",
      preferredDate: date,
      preferredTime: "10:00 AM",
      location: `${UNBROKEN_120} Estate`,
      phone: LONG_EMAIL,
    });
    expect(html).toContain("table-layout: fixed");
    expect(html).toContain("overflow-wrap: anywhere");
    expect(html).not.toContain("break-all");
    expect(html).toContain(LONG_EMAIL);
  });

  it("admin alert and transaction confirmation wrap pathological cells", () => {
    const alert = adminNewBookingAlertTemplate({
      name: "Test Buyer",
      ref: "BKG-2026-00001",
      preferredDate: date,
      preferredTime: "10:00 AM",
      location: UNBROKEN_120,
      email: LONG_UNBROKEN_EMAIL,
    });
    expect(alert).toContain("table-layout: fixed");
    expect(alert).toContain(LONG_UNBROKEN_EMAIL);
    const txn = transactionConfirmationTemplate({
      name: "Test Buyer",
      txnRef: "TXN-2026-00001",
      bookingRef: null,
      propertyLine: `${UNBROKEN_120} · Plot`,
      planName: "Outright",
      isOutright: true,
      depositAmount: null,
      depositDueDate: "15-Dec-2026",
      schedule: [],
      interestAmount: 0,
      interestRate: 0,
      totalPayable: 2900000,
    });
    expect(txn).toContain("table-layout: fixed");
    expect(txn).not.toContain("break-all");
  });
});

describe("receipt PDF wrapping", () => {
  it("wraps a very long email and name instead of overflowing; truncates the fixed estate cell with an ellipsis", async () => {
    // Rendered to text with pdf-parse (the repo embeds NotoSans subsets, so
    // raw-buffer grepping cannot see the glyphs — this asserts on the real
    // rendered output instead).
    const buf = generateReceiptPdf({
      ref: "RCT-2026-00001",
      issuedDate: "15-12-2026",
      clientName: "Daniel Ifenna Okafor Testing Long Names Here",
      clientAddress: ADDRESS_3LINE,
      clientPhone: "+2348012345678",
      clientEmail: LONG_UNBROKEN_EMAIL,
      estateName: `${"E".repeat(60)} Estate`,
      unitType: "Plot",
      plotCode: "TST-200",
      amountPaid: 2900000,
      soldPrice: 2900000,
      payments: [{ date: "15-12-2026", method: "Bank Transfer", amount: 2900000 }],
      receiptUrl: "https://example.com/r/token",
      totalPayable: 2900000,
      totalPaidAfter: 2900000,
      outstandingBalance: 0,
    });
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    // 150-char unbroken email is wrapped by measured width: no single
    // rendered line holds the whole run, but every character survives.
    const lines = text.split("\n");
    expect(lines.every((line) => !line.includes("e".repeat(150)))).toBe(true);
    expect(text.replace(/\s+/g, "")).toContain("e".repeat(150));
    // Fixed-height estate cell: explicit last-resort truncation with ellipsis.
    expect(text).toContain("…");
    expect(text).not.toContain("E".repeat(60));
    // Nothing silently dropped: name words and phone survive.
    expect(text).toContain("Daniel");
    expect(text).toContain("+2348012345678");
  }, 30000);
});

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u1", name: "Admin", email: "admin@x.com", role: "admin" } }),
}));

const PATHO_BOOKING: Record<string, unknown> = {
  id: "bk-1",
  ref: "BKG-2026-00001",
  name: `Buyer ${UNBROKEN_120}`,
  email: LONG_UNBROKEN_EMAIL,
  phone: "+2348012345678",
  preferredDate: new Date("2026-12-15T09:00:00Z"),
  preferredTime: "10:00 AM",
  rescheduledDate: null,
  rescheduledTime: null,
  location: `Estate ${UNBROKEN_120}`,
  agentName: null,
  visitorAgentRaw: null,
  status: "new",
  leadTemperature: "cold",
  outcome: null,
  agentId: null,
  agent: { id: "a1", name: `Agent ${UNBROKEN_120}`, category: "staff", email: "agent@x.com" },
  assignedToUser: null,
  reviewedByUser: null,
  estate: null,
  plotCode: null,
  unitType: null,
  sqm: null,
  sqmNeeded: null,
  selectionType: null,
  possibleDuplicateOfId: null,
  inspectedAt: null,
  formConfirmedAt: null,
  lockedAt: null,
  isTest: false,
  createdAt: new Date("2026-12-01T09:00:00Z"),
  updatedAt: new Date("2026-12-01T09:00:00Z"),
  activities: [
    {
      id: "act-1",
      actorName: "Admin User",
      action: "approve",
      fromStatus: "new",
      toStatus: "under_review",
      note: "Looks good, moving forward",
      createdAt: new Date("2026-12-02T09:00:00Z"),
    },
  ],
  internalNotes: [
    {
      id: "note-1",
      authorName: "Admin User",
      // Pasted-from-Windows body: CRLF, tabs, and a 120-char unbroken run.
      body: `windows clipboard note\r\nsecond line\twith tab ${UNBROKEN_120} end`,
      createdAt: new Date("2026-12-03T09:00:00Z"),
    },
  ],
  messages: [
    {
      id: "msg-1",
      authorName: "Staff Member",
      message: `Client confirmed by phone ${UNBROKEN_200} done`,
      createdAt: new Date("2026-12-04T09:00:00Z"),
    },
  ],
};

vi.mock("@/lib/prisma", () => ({
  prisma: {
    inspectionBooking: {
      findMany: async () => [{ ...PATHO_BOOKING }],
    },
    agent: { findUnique: async () => null },
    transaction: {
      findMany: async () => [
        {
          id: "t1",
          ref: "TXN-2026-00001",
          customerName: `Client ${UNBROKEN_120}`,
          customerEmail: LONG_UNBROKEN_EMAIL,
          estate: `Estate ${UNBROKEN_120}`,
          plotCode: "TST-200",
          status: "ACTIVE",
          totalPayable: 5800000,
          createdAt: new Date("2026-12-01T09:00:00Z"),
          paymentPlan: { name: "Outright" },
          payments: [
            {
              id: "p1",
              amount: 2900000,
              paymentDate: new Date("2026-12-15T09:00:00Z"),
              paymentMethod: "Bank Transfer",
              paymentReference: "PAY-2026-00001",
              status: "CONFIRMED",
            },
          ],
          receipts: [{ paymentId: "p1", ref: "RCT-2026-00001" }],
        },
      ],
    },
    ledgerEntry: {
      findMany: async () => [
        {
          id: "le-t1-base",
          transactionId: "t1",
          type: "CHARGE_BASE",
          amount: 5800000,
          direction: "DEBIT",
          effectiveDate: new Date("2026-12-01T09:00:00Z"),
          createdAt: new Date("2026-12-01T09:00:00Z"),
          method: null,
          bankReference: null,
          paymentId: null,
          note: null,
          reversesEntryId: null,
          payment: null,
        },
        {
          id: "le-t1-pay",
          transactionId: "t1",
          type: "PAYMENT",
          amount: 2900000,
          direction: "CREDIT",
          effectiveDate: new Date("2026-12-15T09:00:00Z"),
          createdAt: new Date("2026-12-15T09:00:00Z"),
          method: "Bank Transfer",
          bankReference: null,
          paymentId: "p1",
          note: null,
          reversesEntryId: null,
          payment: { paymentReference: "PAY-2026-00001" },
        },
      ],
    },
    receipt: { findMany: async () => [{ transactionId: "t1", paymentId: "p1", ref: "RCT-2026-00001" }] },
    payment: {
      findMany: async () => [
        {
          id: "p1",
          transactionId: "t1",
          status: "CONFIRMED",
          amount: 2900000,
          paymentDate: new Date("2026-12-15T09:00:00Z"),
          paymentMethod: "Bank Transfer",
        },
      ],
    },
  },
}));

import { NextRequest } from "next/server";
import { GET as exportBookings } from "@/app/api/admin/bookings/export/route";
import { GET as exportLedger } from "@/app/api/admin/transactions/ledger/route";

describe("bookings export PDF", () => {
  it("wraps the 120-char unbroken strings inside their cells", async () => {
    const res = await exportBookings(new NextRequest("http://localhost/api/admin/bookings/export"));
    expect(res.status).toBe(200);
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    // Wrapped: pre-split chunks present as separate lines (limit 20)…
    expect(text).toContain("Z".repeat(20));
    // …but the full unbroken run never appears on one line (no overflow).
    expect(text).not.toContain(UNBROKEN_120);
    expect(text).not.toContain("e".repeat(150));
    // Nothing silently dropped: ref and markers survive.
    expect(text).toContain("BKG-2026-00001");
  }, 30000);

  it("activity history holds admin-written notes + messages only, wrapped inside cells", async () => {
    const res = await exportBookings(new NextRequest("http://localhost/api/admin/bookings/export"));
    expect(res.status).toBe(200);
    const text = pdfText(Buffer.from(await res.arrayBuffer()));
    // Admin-written content survives: note words and message words render…
    expect(text).toContain("windows clipboard note");
    expect(text).toContain("second line");
    expect(text).toContain("Client confirmed by phone");
    // …wrapped: neither unbroken run appears on one line (no overflow)…
    expect(text).not.toContain(UNBROKEN_120);
    expect(text).not.toContain(UNBROKEN_200);
    // …and the auto system event is gone from the history table.
    expect(text).not.toContain("approve (new");
    expect(text).not.toContain("Looks good, moving forward");
  }, 30000);
});

describe("ledger export PDF", () => {
  it("wraps long client/property/ref cells inside the table", async () => {
    const res = await exportLedger(new NextRequest("http://localhost/api/admin/transactions/ledger"));
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    await parser.destroy();
    const flat = text.replace(/\s+/g, " ");
    // Nothing is dropped: refs, names and plot codes survive.
    expect(flat).toContain("TXN-2026-00001");
    expect(flat).toContain("TST-200");
    expect(flat).toContain("PAY-2026-00001");
    expect(flat).toContain("RCT-2026-00001");
    // The unbroken run is wrapped inside its cell, never emitted as one run
    // (the cell is styled overflow-wrap: anywhere — no clipped text).
    expect(flat).not.toContain(UNBROKEN_120);
  }, 30000);
});
