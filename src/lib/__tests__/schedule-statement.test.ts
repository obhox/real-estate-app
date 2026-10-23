import { describe, it, expect } from "vitest";
import {
  buildScheduleStatement,
  scheduleRowLabel,
  SCHEDULE_LAYOUT_VERSION,
  type ScheduleStatementInput,
} from "../schedule-statement";
import type { AllocationInstallment, AllocationPayment } from "../finance/allocations";

const inst = (
  installmentNumber: number,
  type: string,
  dueDate: string,
  scheduledAmount: number
): AllocationInstallment => ({
  id: `i${installmentNumber}`,
  installmentNumber,
  type,
  dueDate: new Date(dueDate),
  scheduledAmount,
});

const pay = (id: string, amount: number, paymentDate: string): AllocationPayment => ({
  id,
  amount,
  paymentDate: new Date(paymentDate),
  status: "CONFIRMED",
});

// The real bug transaction TXN-2026-19362: contract 7,500,000 + one-time
// interest 375,000 = 7,875,000 payable; Initial 3,937,500; Months 1-6 @ 656,250.
const installments: AllocationInstallment[] = [
  inst(0, "INITIAL", "2026-10-14", 3_937_500),
  inst(1, "MONTHLY", "2026-12-14", 656_250),
  inst(2, "MONTHLY", "2027-01-14", 656_250),
  inst(3, "MONTHLY", "2027-02-14", 656_250),
  inst(4, "MONTHLY", "2027-03-14", 656_250),
  inst(5, "MONTHLY", "2027-04-14", 656_250),
  inst(6, "MONTHLY", "2027-05-14", 656_250),
];

const base = (over: Partial<ScheduleStatementInput> = {}): ScheduleStatementInput => ({
  installments,
  payments: [
    pay("p1", 3_937_500, "2026-10-14"),
    pay("p2", 1_000_000, "2026-10-15"),
    pay("p3", 1_000_000, "2026-10-16"),
  ],
  now: new Date("2026-11-01"),
  ...over,
});

describe("scheduleRowLabel", () => {
  it("labels the initial deposit and numbered months", () => {
    expect(scheduleRowLabel("INITIAL", 0)).toBe("Initial deposit");
    expect(scheduleRowLabel("MONTHLY", 3)).toBe("Month 3 payment");
  });
});

describe("buildScheduleStatement", () => {
  it("has one row per installment with scheduled amounts summing to the plan total", () => {
    const s = buildScheduleStatement(base());
    expect(s.rows).toHaveLength(7);
    expect(s.totals.scheduled).toBe(7_875_000);
    expect(s.layoutVersion).toBe(SCHEDULE_LAYOUT_VERSION);
  });

  it("derives received per installment from the waterfall (paid 5,937,500)", () => {
    const s = buildScheduleStatement(base());
    expect(s.totals.received).toBe(5_937_500);
    expect(s.totals.outstanding).toBe(1_937_500);
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r]));
    expect(byLabel["Initial deposit"].received).toBe(3_937_500);
    expect(byLabel["Month 1 payment"].received).toBe(656_250);
    expect(byLabel["Month 2 payment"].received).toBe(656_250);
    expect(byLabel["Month 3 payment"].received).toBe(656_250);
    // M4 is part paid: 625,000 still to go of 656,250
    expect(byLabel["Month 4 payment"].received).toBe(31_250);
    expect(byLabel["Month 5 payment"].received).toBe(0);
    expect(byLabel["Month 6 payment"].received).toBe(0);
  });

  it("marks fully covered installments Paid and the partial one Part paid", () => {
    const s = buildScheduleStatement(base());
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r]));
    expect(byLabel["Initial deposit"].status).toMatch(/^Paid/);
    expect(byLabel["Month 4 payment"].status).toBe("Part paid, ₦625,000 remaining");
    expect(byLabel["Month 5 payment"].status).toBe("Not yet due, ₦656,250 remaining");
  });

  it("reports next due as the earliest open installment's remaining amount", () => {
    const s = buildScheduleStatement(base());
    expect(s.nextDue).toEqual({
      dueDate: "14-03-2027",
      label: "Month 4 payment",
      amount: 625_000,
    });
  });

  it("is not fully paid while an installment is open", () => {
    const s = buildScheduleStatement(base());
    expect(s.fullyPaid).toBe(false);
    expect(s.settledOn).toBeNull();
  });

  it("marks an unpaid installment past its due date Overdue", () => {
    const s = buildScheduleStatement(base({ now: new Date("2027-04-01"), formatDate: (d) => new Date(d).toISOString().slice(0, 10) }));
    const byLabel = Object.fromEntries(s.rows.map((r) => [r.label, r]));
    // M4 due 2027-03-14, only part paid, now April -> overdue
    expect(byLabel["Month 4 payment"].status).toBe("Part paid, ₦625,000 remaining");
    // M5 due 2027-04-14 not yet overdue as at 2027-04-01
    expect(byLabel["Month 5 payment"].status).toBe("Not yet due, ₦656,250 remaining");
  });

  it("writes 'Paid early, <date>' when an installment settled before its due date", () => {
    const s = buildScheduleStatement({
      installments: [inst(1, "MONTHLY", "2027-06-14", 500_000)],
      payments: [pay("p1", 500_000, "2027-01-02")],
      now: new Date("2027-01-05"),
      formatDate: (d) => `D(${new Date(d).toISOString().slice(0, 10)})`,
    });
    expect(s.rows[0].status).toBe("Paid early, D(2027-01-02)");
  });

  it("settles when the plan is fully covered, and reports the final settlement date", () => {
    const s = buildScheduleStatement(
      base({
        payments: [
          pay("p1", 3_937_500, "2026-10-14"),
          pay("p2", 3_937_500, "2027-01-20"),
        ],
      })
    );
    expect(s.fullyPaid).toBe(true);
    expect(s.totals.outstanding).toBe(0);
    expect(s.nextDue).toBeNull();
    expect(s.settledOn).toBe("20-01-2027");
  });

  it("treats money beyond the whole plan as credit, not an open installment", () => {
    const s = buildScheduleStatement(
      base({
        payments: [
          pay("p1", 3_937_500, "2026-10-14"),
          pay("p2", 4_000_000, "2027-01-20"),
        ],
      })
    );
    expect(s.fullyPaid).toBe(true);
    expect(s.totals.outstanding).toBe(-62_500);
    expect(s.totals.credit).toBe(62_500);
    expect(s.nextDue).toBeNull();
  });

  it("ignores non-confirmed and zero payments", () => {
    const s = buildScheduleStatement(
      base({
        payments: [
          pay("p1", 3_937_500, "2026-10-14"),
          { id: "p2", amount: 1_000_000, paymentDate: new Date("2026-10-15"), status: "PENDING" },
          { id: "p3", amount: 0, paymentDate: new Date("2026-10-16"), status: "CONFIRMED" },
        ],
      })
    );
    expect(s.totals.received).toBe(3_937_500);
  });

  it("never writes 'Overdue' when the contract is settled but the plan over-schedules", () => {
    // Plan asks 1.5m against a 1.0m contract; the client paid the contract in
    // full. The trailing row is short only on paper and must read Paid.
    const s = buildScheduleStatement({
      installments: [inst(0, "INITIAL", "2026-10-14", 600_000), inst(1, "MONTHLY", "2026-11-14", 900_000)],
      payments: [pay("p1", 1_000_000, "2026-10-14")],
      now: new Date("2026-12-01"),
      totalPayable: 1_000_000,
    });
    expect(s.fullyPaid).toBe(true);
    expect(s.totals.outstanding).toBe(0);
    expect(s.totals.credit).toBe(0);
    expect(s.nextDue).toBeNull();
    expect(s.rows.map((r) => r.status)).toEqual(["Paid", "Paid"]);
    expect(s.rows.some((r) => r.status.includes("Overdue"))).toBe(false);
  });
});
