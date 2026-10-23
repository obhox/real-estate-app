import { describe, it, expect } from "vitest";
import StatusBadge, { statusLabel, statusStyle } from "../StatusBadge";
import { trendFor } from "../TrendChip";
import { describePayment } from "@/lib/paymentConfirmation";
import { receiptAmountsRows } from "@/lib/receipt-amounts";

describe("StatusBadge mapping", () => {
  it("maps every known status to a pill class (no unstyled fallback)", () => {
    const known = [
      "new", "under_review", "on_hold", "approved", "rescheduled", "active", "closed",
      "sold", "interested", "not_sold", "cold", "warm", "hot",
      "CONFIRMED", "PAID_IN_FULL", "PAID", "GENERATED", "generated", "sent", "SENT",
      "PENDING_VERIFICATION", "pending", "PENDING", "DUE", "PARTIALLY_PAID", "OVERDUE",
      "FAILED", "failed", "CANCELLED", "WAIVED", "DRAFT", "draft",
      "BOOKING_FLOW", "PAYMENT_CONFIRMATION", "ADMIN_MANUAL",
      "Paid", "Late", "Partial", "Pending", "Settled",
    ];
    for (const s of known) {
      expect(statusStyle(s), s).toContain("bg-");
    }
    expect(statusStyle("something-new")).toContain("bg-transparent");
  });

  it("humanizes labels without leaking enum syntax", () => {
    expect(statusLabel("PENDING_VERIFICATION")).toBe("Pending verification");
    expect(statusLabel("PAID_IN_FULL")).toBe("Paid in full");
    expect(statusLabel("under_review")).toBe("Under Review");
    expect(statusLabel("ADMIN_MANUAL")).toBe("Manual");
    expect(statusLabel("weird_status")).toBe("Weird Status");
    for (const s of ["PENDING_VERIFICATION", "PAID_IN_FULL", "PARTIALLY_PAID"]) {
      expect(statusLabel(s)).not.toContain("_");
    }
  });

  it("renders a pill element", () => {
    const el = StatusBadge({ status: "CONFIRMED" }) as unknown as { props: { className: string; children: string } };
    expect(el.props.className).toContain("rounded-full");
    expect(el.props.children).toBe("Confirmed");
  });
});

describe("trend chip rules", () => {
  it("never shows ▲100%: prior 0 + current > 0 is New", () => {
    expect(trendFor(5_800_000, 0)).toEqual({ kind: "new" });
  });
  it("both 0 is flat", () => {
    expect(trendFor(0, 0)).toEqual({ kind: "flat" });
  });
  it("normal up/down math", () => {
    expect(trendFor(150, 100)).toEqual({ kind: "up", pct: 50 });
    expect(trendFor(50, 100)).toEqual({ kind: "down", pct: 50 });
    expect(trendFor(100, 100)).toEqual({ kind: "flat" });
  });
});

describe("receipt amounts wording", () => {
  const txn = { estate: "Belgrove Peninsula", unitType: "3-Bedroom Terrace Duplex", plotCode: "PEN-150SQM" };
  it("initial payment reads like the spec example", () => {
    expect(describePayment({ type: "INITIAL", installmentNumber: 0 }, txn)).toBe(
      "Initial payment: Belgrove Peninsula, 3-Bedroom Terrace Duplex (PEN-150SQM)"
    );
  });
  it("monthly payments name the month, never 'Payment for'", () => {
    const d = describePayment({ type: "MONTHLY", installmentNumber: 3 }, txn);
    expect(d).toBe("Month 3 payment: Belgrove Peninsula, 3-Bedroom Terrace Duplex (PEN-150SQM)");
    expect(d).not.toMatch(/payment for/i);
  });
  it("omits missing unit/plot cleanly", () => {
    expect(describePayment(null, { estate: "Estate" })).toBe("Initial payment: Estate");
  });

  it("amounts block uses the shared order with no installment or legacy labels", () => {
    const rows = receiptAmountsRows({
      thisPayment: 2_905_000,
      totalPrice: 8_300_000,
      paidToDate: 2_905_000,
      balanceRemaining: 5_395_000,
      discount: 0,
    });
    expect(rows.map((r) => r.label)).toEqual([
      "This payment",
      "Total price",
      "Paid to date",
      "Balance remaining",
    ]);
    for (const r of rows) {
      expect(r.label).not.toMatch(/installment|amount before discount|final amount paid/i);
    }
  });
});
