import { describe, it, expect } from "vitest";
import { validatePayment, normalizeReference } from "@/lib/paymentValidation";

const NOW = new Date("2026-10-16T10:00:00.000Z");
const CONTRACT = new Date("2026-10-01T12:00:00.000Z");
const DATE = new Date("2026-10-15T12:00:00.000Z");

function base(over: Partial<Parameters<typeof validatePayment>[0]> = {}) {
  return validatePayment({
    amount: 656_250,
    paymentDate: DATE,
    paymentMethod: "Cash",
    bankReference: null,
    contractDate: CONTRACT,
    totalPayable: 7_875_000,
    outstandingBalance: 3_937_500,
    dueNow: 656_250,
    now: NOW,
    ...over,
  });
}

const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe("validatePayment — hard blocks", () => {
  it("accepts a clean payment", () => {
    const r = base();
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.requiresAcknowledgement).toBe(false);
  });

  it("blocks non-positive and fractional amounts", () => {
    expect(codes(base({ amount: 0 }).errors)).toContain("AMOUNT_NOT_POSITIVE");
    expect(codes(base({ amount: -5 }).errors)).toContain("AMOUNT_NOT_POSITIVE");
    expect(codes(base({ amount: 100.5 }).errors)).toContain("AMOUNT_NOT_WHOLE");
  });

  it("blocks an amount above the outstanding balance and states the excess", () => {
    const r = base({ amount: 4_000_000, outstandingBalance: 3_937_500 });
    const err = r.errors.find((e) => e.code === "AMOUNT_EXCEEDS_OUTSTANDING");
    expect(err).toBeTruthy();
    expect(err!.meta?.overBy).toBe(62_500);
  });

  it("blocks a payment dated before the contract and one dated in the future", () => {
    expect(codes(base({ paymentDate: new Date("2026-09-30T12:00:00.000Z") }).errors)).toContain("DATE_BEFORE_CONTRACT");
    expect(codes(base({ paymentDate: new Date("2026-10-20T12:00:00.000Z") }).errors)).toContain("DATE_IN_FUTURE");
  });

  it("treats the contract day and today as valid (same-day is not 'before'/'future')", () => {
    expect(codes(base({ paymentDate: new Date("2026-10-01T09:00:00.000Z") }).errors)).not.toContain("DATE_BEFORE_CONTRACT");
    expect(codes(base({ paymentDate: new Date("2026-10-16T06:00:00.000Z") }).errors)).not.toContain("DATE_IN_FUTURE");
  });

  it("requires a reference for Bank Transfer, allows blank for Cash", () => {
    expect(codes(base({ paymentMethod: "Bank Transfer", bankReference: "  " }).errors)).toContain("REFERENCE_REQUIRED");
    expect(codes(base({ paymentMethod: "Bank Transfer", bankReference: "TRF-88231" }).errors)).not.toContain("REFERENCE_REQUIRED");
    expect(codes(base({ paymentMethod: "Cash", bankReference: null }).errors)).not.toContain("REFERENCE_REQUIRED");
  });

  it("blocks a duplicate bank reference after normalisation", () => {
    const r = base({
      paymentMethod: "Bank Transfer",
      bankReference: " trf-88231 ",
      existingReferences: ["TRF-88231", null, "  "],
    });
    expect(codes(r.errors)).toContain("REFERENCE_DUPLICATE");
  });

  it("normalises references consistently", () => {
    expect(normalizeReference("  trf   88231 ")).toBe("TRF 88231");
    expect(normalizeReference(null)).toBe("");
  });
});

describe("validatePayment — warnings", () => {
  it("warns on overpayment spill and needs acknowledgement", () => {
    const r = base({ amount: 1_000_000, outstandingBalance: 3_937_500, dueNow: 656_250 });
    expect(codes(r.warnings)).toContain("OVERPAYMENT_SPILL");
    expect(r.requiresAcknowledgement).toBe(true);
    const r2 = base({ amount: 1_000_000, outstandingBalance: 3_937_500, dueNow: 656_250, allocationReviewed: true });
    expect(r2.requiresAcknowledgement).toBe(false);
  });

  it("warns on underpayment shortfall", () => {
    const r = base({ amount: 300_000, dueNow: 656_250 });
    expect(codes(r.warnings)).toContain("UNDERPAYMENT_SHORTFALL");
    expect(r.requiresAcknowledgement).toBe(true);
  });

  it("does not warn when nothing is due", () => {
    const r = base({ amount: 100_000, dueNow: 0 });
    expect(r.warnings).toEqual([]);
  });
});
