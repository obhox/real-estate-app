import { describe, it, expect } from "vitest";
import {
  replayAllocation,
  orderConfirmedPayments,
  deriveInstallmentViews,
  type AllocationInstallment,
  type AllocationPayment,
} from "../finance/allocations";

// The real bug transaction TXN-2026-19362: total 7,875,000 = contract
// 7,500,000 + one-time interest 375,000. Initial 3,937,500; Months 1-6 at
// 656,250. Three confirmed payments must waterfall, not bind to one pointer.
const TXN19362: AllocationInstallment[] = [
  { id: "i0", installmentNumber: 0, type: "INITIAL", dueDate: new Date("2026-10-14T00:00:00Z"), scheduledAmount: 3_937_500 },
  { id: "i1", installmentNumber: 1, type: "MONTHLY", dueDate: new Date("2026-11-14T00:00:00Z"), scheduledAmount: 656_250 },
  { id: "i2", installmentNumber: 2, type: "MONTHLY", dueDate: new Date("2026-12-14T00:00:00Z"), scheduledAmount: 656_250 },
  { id: "i3", installmentNumber: 3, type: "MONTHLY", dueDate: new Date("2027-01-14T00:00:00Z"), scheduledAmount: 656_250 },
  { id: "i4", installmentNumber: 4, type: "MONTHLY", dueDate: new Date("2027-02-14T00:00:00Z"), scheduledAmount: 656_250 },
  { id: "i5", installmentNumber: 5, type: "MONTHLY", dueDate: new Date("2027-03-14T00:00:00Z"), scheduledAmount: 656_250 },
  { id: "i6", installmentNumber: 6, type: "MONTHLY", dueDate: new Date("2027-04-14T00:00:00Z"), scheduledAmount: 656_250 },
];

const P19362: AllocationPayment[] = [
  { id: "pa", amount: 3_937_500, paymentDate: new Date("2026-10-14T10:00:00Z"), status: "CONFIRMED" },
  { id: "pb", amount: 1_000_000, paymentDate: new Date("2026-10-15T10:00:00Z"), status: "CONFIRMED" },
  { id: "pc", amount: 1_000_000, paymentDate: new Date("2026-10-16T10:00:00Z"), status: "CONFIRMED" },
];

const paidById = (insts: { id: string; confirmedPaid: number }[]) =>
  Object.fromEntries(insts.map((i) => [i.id, i.confirmedPaid]));

describe("replayAllocation — the exact reported case", () => {
  it("waterfalls 5,937,500 across Initial + Months 1-4 (Month 4 partial)", () => {
    const { installments, credit } = replayAllocation(TXN19362, P19362);
    expect(paidById(installments)).toEqual({
      i0: 3_937_500, // Initial paid in full
      i1: 656_250, // Month 1 paid
      i2: 656_250, // Month 2 paid
      i3: 656_250, // Month 3 paid
      i4: 31_250, // Month 4 part paid
      i5: 0,
      i6: 0,
    });
    expect(credit).toBe(0);
    // The sum of allocations is exactly the confirmed total.
    const total = installments.reduce((s, i) => s + i.confirmedPaid, 0);
    expect(total).toBe(5_937_500);
  });

  it("never lets a later installment be Paid while an earlier one is open", () => {
    const { installments } = replayAllocation(TXN19362, P19362);
    const open = installments.findIndex((i) => i.confirmedPaid < i.scheduledAmount);
    for (let k = open + 1; k < installments.length; k++) {
      expect(installments[k].confirmedPaid).toBe(0);
    }
  });

  it("M5/M6 remain Pending and M4 reads Partial at the statement date", () => {
    const now = new Date("2026-10-17T00:00:00Z");
    const { views } = deriveInstallmentViews(TXN19362, P19362, now);
    const byId = new Map(views.map((v) => [v.id, v]));
    expect(byId.get("i0")?.status).toBe("Paid");
    expect(byId.get("i3")?.status).toBe("Paid");
    expect(byId.get("i4")?.status).toBe("Partial");
    expect(byId.get("i4")?.confirmedPaid).toBe(31_250);
    expect(byId.get("i5")?.status).toBe("Pending");
    expect(byId.get("i6")?.status).toBe("Pending");
  });
});

describe("replayAllocation — underpayment", () => {
  const installments: AllocationInstallment[] = [
    { id: "a", installmentNumber: 0, type: "INITIAL", dueDate: new Date("2026-10-01T00:00:00Z"), scheduledAmount: 1_000_000 },
    { id: "b", installmentNumber: 1, type: "MONTHLY", dueDate: new Date("2026-11-01T00:00:00Z"), scheduledAmount: 1_000_000 },
  ];

  it("applies a part payment to the earliest open installment only", () => {
    const { installments: out, credit } = replayAllocation(installments, [
      { id: "p1", amount: 400_000, paymentDate: new Date("2026-10-05T00:00:00Z"), status: "CONFIRMED" },
    ]);
    expect(paidById(out)).toEqual({ a: 400_000, b: 0 });
    expect(credit).toBe(0);
  });

  it("reads Partial before due and Late after due, never Paid", () => {
    const payments = [{ id: "p1", amount: 400_000, paymentDate: new Date("2026-10-05T00:00:00Z"), status: "CONFIRMED" }];
    const before = deriveInstallmentViews(installments, payments, new Date("2026-09-20T00:00:00Z"));
    expect(before.views.find((v) => v.id === "a")?.status).toBe("Partial");
    const after = deriveInstallmentViews(installments, payments, new Date("2026-11-15T00:00:00Z"));
    expect(after.views.find((v) => v.id === "a")?.status).toBe("Late");
    expect(after.views.find((v) => v.id === "a")?.overdue).toBe(true);
  });
});

describe("replayAllocation — overpayment", () => {
  const installments: AllocationInstallment[] = [
    { id: "a", installmentNumber: 0, type: "INITIAL", dueDate: new Date("2026-10-01T00:00:00Z"), scheduledAmount: 1_000_000 },
    { id: "b", installmentNumber: 1, type: "MONTHLY", dueDate: new Date("2026-11-01T00:00:00Z"), scheduledAmount: 1_000_000 },
    { id: "c", installmentNumber: 2, type: "MONTHLY", dueDate: new Date("2026-12-01T00:00:00Z"), scheduledAmount: 1_000_000 },
  ];

  it("spills across installments and holds any surplus as credit, not on one row", () => {
    const { installments: out, credit } = replayAllocation(installments, [
      { id: "p1", amount: 2_500_000, paymentDate: new Date("2026-10-05T00:00:00Z"), status: "CONFIRMED" },
    ]);
    expect(paidById(out)).toEqual({ a: 1_000_000, b: 1_000_000, c: 500_000 });
    expect(credit).toBe(0);

    const over = replayAllocation(installments, [
      { id: "p1", amount: 3_500_000, paymentDate: new Date("2026-10-05T00:00:00Z"), status: "CONFIRMED" },
    ]);
    expect(paidById(over.installments)).toEqual({ a: 1_000_000, b: 1_000_000, c: 1_000_000 });
    expect(over.credit).toBe(500_000);
    // No installment ever exceeds its scheduled amount.
    for (const i of over.installments) expect(i.confirmedPaid).toBeLessThanOrEqual(i.scheduledAmount);
  });
});

describe("replayAllocation — derived from payment history, not the pointer", () => {
  it("ignores a divergent installmentId pointer and follows date order", () => {
    const installments: AllocationInstallment[] = [
      { id: "a", installmentNumber: 0, type: "INITIAL", dueDate: new Date("2026-10-01T00:00:00Z"), scheduledAmount: 100 },
      { id: "b", installmentNumber: 1, type: "MONTHLY", dueDate: new Date("2026-11-01T00:00:00Z"), scheduledAmount: 100 },
      { id: "c", installmentNumber: 2, type: "MONTHLY", dueDate: new Date("2026-12-01T00:00:00Z"), scheduledAmount: 100 },
    ];
    // Pointers say b then c; the waterfall fills a then b.
    const { installments: out } = replayAllocation(installments, [
      { id: "p1", amount: 100, paymentDate: new Date("2026-10-02T00:00:00Z"), status: "CONFIRMED" },
      { id: "p2", amount: 100, paymentDate: new Date("2026-10-03T00:00:00Z"), status: "CONFIRMED" },
    ]);
    expect(paidById(out)).toEqual({ a: 100, b: 100, c: 0 });
  });

  it("breaks date ties deterministically by id, and ignores unconfirmed money", () => {
    const ordered = orderConfirmedPayments([
      { id: "z", amount: 10, paymentDate: new Date("2026-10-02T00:00:00Z"), status: "CONFIRMED" },
      { id: "a", amount: 10, paymentDate: new Date("2026-10-02T00:00:00Z"), status: "CONFIRMED" },
      { id: "pen", amount: 999, paymentDate: new Date("2026-10-01T00:00:00Z"), status: "PENDING_VERIFICATION" },
      { id: "can", amount: 999, paymentDate: new Date("2026-10-01T00:00:00Z"), status: "CANCELLED" },
    ]);
    expect(ordered.map((p) => p.id)).toEqual(["a", "z"]);
  });
});

describe("replayAllocation — invariants", () => {
  it("sum(allocated) + credit === sum(confirmed) for varied histories", () => {
    const histories: { installments: AllocationInstallment[]; payments: AllocationPayment[] }[] = [
      { installments: TXN19362, payments: P19362 },
      { installments: TXN19362, payments: [] },
      {
        installments: TXN19362,
        payments: [{ id: "x", amount: 7_000_000, paymentDate: new Date("2026-10-20T00:00:00Z"), status: "CONFIRMED" }],
      },
    ];
    for (const h of histories) {
      const { installments: out, credit } = replayAllocation(h.installments, h.payments);
      const confirmed = orderConfirmedPayments(h.payments).reduce((s, p) => s + p.amount, 0);
      const allocated = out.reduce((s, i) => s + i.confirmedPaid, 0);
      expect(allocated + credit).toBe(confirmed);
    }
  });

  it("never reduces a scheduled amount (one-time interest is not eroded)", () => {
    const { installments: out } = replayAllocation(TXN19362, P19362);
    for (const i of out) {
      const src = TXN19362.find((s) => s.id === i.id)!;
      expect(i.scheduledAmount).toBe(src.scheduledAmount);
    }
    // Total scheduled still 7,875,000 (contract + interest) however paid early.
    expect(out.reduce((s, i) => s + i.scheduledAmount, 0)).toBe(7_875_000);
  });
});
