import { describe, it, expect } from "vitest";
import {
  getCollectedRevenue,
  getOverdueInstallments,
  getPendingVerification,
  getTransactionFinancials,
  getTransactionOverviews,
  getTransactionSummary,
  toDisplayStatus,
  type FinanceDb,
  type FinancialInstallmentInput,
} from "../finance";

// One dataset, three surfaces: dashboard revenue, ledger totals and the
// transaction summary must return identical figures for the same data.
const NOW = new Date("2026-09-28T12:00:00Z");
const PAST = new Date("2026-09-10T12:00:00Z");
const FUTURE = new Date("2026-10-28T12:00:00Z");

const INSTALLMENTS = [
  { id: "i0", transactionId: "t1", installmentNumber: 0, type: "INITIAL", dueDate: PAST, scheduledAmount: 2_900_000, status: "PAID" },
  { id: "i1", transactionId: "t1", installmentNumber: 1, type: "MONTHLY", dueDate: FUTURE, scheduledAmount: 1_450_000, status: "PENDING" },
  { id: "i2", transactionId: "t1", installmentNumber: 2, type: "MONTHLY", dueDate: FUTURE, scheduledAmount: 1_450_000, status: "PENDING" },
  // isTest fixture: must never leak into any figure.
  { id: "ix", transactionId: "tX", installmentNumber: 0, type: "INITIAL", dueDate: PAST, scheduledAmount: 10_000_000, status: "DUE" },
];

const PAYMENTS = [
  { id: "p1", amount: 2_900_000, paymentDate: new Date("2026-09-15T10:00:00Z"), status: "CONFIRMED", installmentId: "i0", transactionId: "t1" },
  { id: "p2", amount: 1_450_000, paymentDate: new Date("2026-09-20T10:00:00Z"), status: "PENDING_VERIFICATION", installmentId: "i1", transactionId: "t1" },
  { id: "p3", amount: 2_900_000, paymentDate: new Date("2026-09-16T10:00:00Z"), status: "CANCELLED", installmentId: "i0", transactionId: "t1" },
  { id: "px", amount: 10_000_000, paymentDate: new Date("2026-09-15T10:00:00Z"), status: "CONFIRMED", installmentId: "ix", transactionId: "tX" },
];

type Where = {
  status?: string | { in?: string[]; notIn?: string[] };
  transactionId?: string | { in?: string[] };
  transaction?: { isTest?: boolean };
  installmentId?: { in?: (string | null)[] };
  paymentDate?: { gte?: Date; lte?: Date; lt?: Date };
  dueDate?: { lt?: Date };
};

function matchPayment(p: (typeof PAYMENTS)[number], where: Where): boolean {
  const st = where.status;
  if (typeof st === "string" && p.status !== st) return false;
  if (typeof st === "object" && st.in && !st.in.includes(p.status)) return false;
  if (typeof st === "object" && st.notIn && st.notIn.includes(p.status)) return false;
  const tid = where.transactionId;
  if (typeof tid === "string" && p.transactionId !== tid) return false;
  if (typeof tid === "object" && tid.in && !tid.in.includes(p.transactionId)) return false;
  if (where.transaction?.isTest === false && p.transactionId === "tX") return false;
  const iid = where.installmentId;
  if (iid?.in && !iid.in.includes(p.installmentId)) return false;
  const pd = where.paymentDate;
  if (pd?.gte && p.paymentDate < pd.gte) return false;
  if (pd?.lte && p.paymentDate > pd.lte) return false;
  if (pd?.lt && p.paymentDate >= pd.lt) return false;
  return true;
}

function matchInstallment(r: (typeof INSTALLMENTS)[number], where: Where): boolean {
  if (where.transaction?.isTest === false && r.transactionId === "tX") return false;
  if (where.dueDate?.lt && r.dueDate >= where.dueDate.lt) return false;
  const st2 = where.status;
  if (typeof st2 === "object" && st2.notIn && st2.notIn.includes(r.status)) return false;
  return true;
}

const fakeDb: FinanceDb = {
  payment: {
    aggregate: async (args: { where: Where }) => ({
      _sum: { amount: PAYMENTS.filter((p) => matchPayment(p, args.where)).reduce((s, p) => s + p.amount, 0) || null },
    }),
    count: async (args: { where: Where }) => PAYMENTS.filter((p) => matchPayment(p, args.where)).length,
    findMany: async (args: { where: Where }) => PAYMENTS.filter((p) => matchPayment(p, args.where)),
  },
  installment: {
    findMany: async (args: { where: Where }) => INSTALLMENTS.filter((r) => matchInstallment(r, args.where ?? {})),
  },
  transaction: {
    findMany: async () => [{ id: "t1", totalPayable: 5_800_000 }],
    findUnique: async (args: { where: { id: string } }) =>
      args.where.id === "tX"
        ? { id: "tX", ref: "TXN-TEST", totalPayable: 10_000_000, isTest: true, installments: [] }
        : {
            id: "t1",
            ref: "TXN-2026-00001",
            totalPayable: 5_800_000,
            isTest: false,
            installments: INSTALLMENTS.filter((r) => r.transactionId === "t1"),
          },
  },
};

describe("finance: collected revenue", () => {
  it("counts CONFIRMED only — pending and voided never count, isTest excluded", async () => {
    await expect(getCollectedRevenue({}, fakeDb)).resolves.toBe(2_900_000);
    await expect(getCollectedRevenue({ from: new Date("2026-09-01T00:00:00Z") }, fakeDb)).resolves.toBe(2_900_000);
    await expect(getCollectedRevenue({ from: new Date("2026-10-01T00:00:00Z") }, fakeDb)).resolves.toBe(0);
  });

  it("includeTest reveals fixtures (toggle behavior)", async () => {
    await expect(getCollectedRevenue({ includeTest: true }, fakeDb)).resolves.toBe(12_900_000);
    await expect(getTransactionSummary("tX", fakeDb, NOW)).resolves.toBe(null);
    const shown = await getTransactionSummary("tX", fakeDb, NOW, { includeTest: true });
    expect(shown?.confirmedPaid).toBe(10_000_000);
  });

  it("pending verification counts but never collects", async () => {
    await expect(getPendingVerification(fakeDb)).resolves.toEqual({ count: 1, total: 1_450_000 });
    await expect(getPendingVerification(fakeDb, { includeTest: true })).resolves.toEqual({ count: 1, total: 1_450_000 });
  });
});

describe("finance: one dataset, identical figures on all surfaces", () => {
  it("dashboard revenue == ledger total == transaction summary", async () => {
    const revenue = await getCollectedRevenue({ from: new Date("2026-09-01T00:00:00Z") }, fakeDb);
    const summary = await getTransactionSummary("t1", fakeDb, NOW);
    expect(summary?.confirmedPaid).toBe(revenue);
    expect(summary?.outstanding).toBe(5_800_000 - revenue);
    expect(summary?.progressPct).toBe(50);
    expect(summary?.overdueCount).toBe(0);
  });
});

describe("finance: installments", () => {
  it("derives Paid / Late / Partial / Pending from confirmed money", () => {
    expect(toDisplayStatus(2_900_000, 2_900_000, PAST, NOW)).toBe("Paid");
    expect(toDisplayStatus(0, 2_900_000, PAST, NOW)).toBe("Late");
    expect(toDisplayStatus(1_000_000, 2_900_000, PAST, NOW)).toBe("Late"); // past due beats partial
    expect(toDisplayStatus(1_000_000, 2_900_000, FUTURE, NOW)).toBe("Partial");
    expect(toDisplayStatus(0, 2_900_000, FUTURE, NOW)).toBe("Pending");
  });

  it("overdue queue skips paid and test installments", async () => {
    const overdue = await getOverdueInstallments(fakeDb, NOW);
    expect(overdue.map((r) => r.id)).toEqual([]);
  });

  it("summary exposes pending-per-installment without counting it paid", async () => {
    const summary = await getTransactionSummary("t1", fakeDb, NOW);
    const i1 = summary?.installments.find((i) => i.id === "i1");
    expect(i1?.confirmedPaid).toBe(0);
    expect(i1?.pendingTotal).toBe(1_450_000);
    expect(i1?.status).toBe("Pending");
  });

  it("overviews agree with the summary for the same transaction", async () => {
    const overviews = await getTransactionOverviews(["t1"], fakeDb, NOW);
    const summary = await getTransactionSummary("t1", fakeDb, NOW);
    const ov = overviews.get("t1")!;
    expect(ov.confirmedPaid).toBe(summary?.confirmedPaid);
    expect(ov.outstanding).toBe(summary?.outstanding);
    expect(ov.overdueCount).toBe(summary?.overdueCount);
    expect(overviews.get("missing")).toBe(undefined);
    expect((await getTransactionOverviews([], fakeDb, NOW)).size).toBe(0);
  });
});

// A balance-first rule: totalPayable - confirmedPaid decides the headline
// status. A schedule whose rows don't sum to the contract can no longer make a
// settled transaction read "Behind", and money past due is the only thing that
// can make an unsettled one read "Behind".
describe("finance: balance decides the status", () => {
  const PAST2 = new Date("2026-09-01T00:00:00Z");
  const FUTURE2 = new Date("2026-10-01T00:00:00Z");

  const inst = (
    installmentNumber: number,
    dueDate: Date,
    scheduledAmount: number,
    confirmedPaid: number
  ): FinancialInstallmentInput => ({ installmentNumber, type: "MONTHLY", dueDate, scheduledAmount, confirmedPaid });

  it("schedule rows summing above the contract cannot make a settled txn Behind", () => {
    // Sum(scheduled) 1.5m > contract 1.0m, all 1.0m paid: the trailing row is
    // short and past due, but the client owes nothing.
    const fin = getTransactionFinancials(
      { totalPayable: 1_000_000, installments: [inst(0, PAST2, 600_000, 0), inst(1, PAST2, 900_000, 0)], unlinkedConfirmed: 1_000_000 },
      NOW
    );
    expect(fin.outstanding).toBe(0);
    expect(fin.isFullyPaid).toBe(true);
    expect(fin.isOverdue).toBe(false);
    expect(fin.overdueCount).toBe(0);
    expect(fin.overdueAmount).toBe(0);
    expect(fin.nextInstallment).toBe(null);
    expect(fin.daysOverdue).toBe(null);
  });

  it("schedule deficit: every row covered but balance still owed — on track, flagged", () => {
    const fin = getTransactionFinancials(
      { totalPayable: 1_000_000, installments: [inst(0, PAST2, 400_000, 400_000), inst(1, PAST2, 300_000, 300_000)] },
      NOW
    );
    expect(fin.outstanding).toBe(300_000);
    expect(fin.isFullyPaid).toBe(false);
    expect(fin.isOverdue).toBe(false);
    expect(fin.nextInstallment).toBe(null);
    expect(fin.scheduleDeficit).toBe(true);
  });

  it("overpayment is settled and flagged, never Behind", () => {
    const fin = getTransactionFinancials(
      { totalPayable: 1_000_000, installments: [inst(0, PAST2, 1_000_000, 1_000_000)], unlinkedConfirmed: 250_000 },
      NOW
    );
    expect(fin.outstanding).toBe(-250_000);
    expect(fin.isOverpaid).toBe(true);
    expect(fin.overpaidAmount).toBe(250_000);
    expect(fin.isFullyPaid).toBe(true);
    expect(fin.isOverdue).toBe(false);
  });

  it("overdue is money past due, with days since the first uncovered due date", () => {
    const fin = getTransactionFinancials(
      { totalPayable: 10_000_000, installments: [inst(0, new Date("2026-09-01T00:00:00Z"), 2_000_000, 1_500_000), inst(1, FUTURE2, 2_000_000, 0)] },
      NOW
    );
    expect(fin.overdueAmount).toBe(500_000);
    expect(fin.overdueCount).toBe(1);
    expect(fin.isOverdue).toBe(true);
    expect(fin.daysOverdue).toBe(27);
    expect(fin.nextInstallment?.amountDue).toBe(500_000);
    expect(fin.daysUntilDue).toBe(null);
  });

  it("overdue amount equals remaining on the past-due rows (waterfall carry)", () => {
    const fin = getTransactionFinancials(
      {
        totalPayable: 10_000_000,
        installments: [inst(0, PAST2, 2_000_000, 2_000_000), inst(1, PAST2, 2_000_000, 500_000), inst(2, FUTURE2, 2_000_000, 0)],
      },
      NOW
    );
    expect(fin.overdueAmount).toBe(1_500_000);
    expect(fin.overdueCount).toBe(1);
    expect(fin.nextInstallment?.number).toBe(1);
    expect(fin.nextInstallment?.amountDue).toBe(1_500_000);
    // The next uncovered row is itself the past-due one, so it reads as overdue.
    expect(fin.daysOverdue).toBe(27);
    expect(fin.daysUntilDue).toBe(null);
  });

  it("next due advances as cumulative confirmed money grows", () => {
    const schedule = [inst(0, PAST2, 3_233_333, 3_233_333), inst(1, FUTURE2, 3_233_333, 0), inst(2, FUTURE2, 3_233_334, 0)];
    const mid = getTransactionFinancials({ totalPayable: 9_700_000, installments: schedule }, NOW);
    expect(mid.nextInstallment?.number).toBe(1);
    expect(mid.isOverdue).toBe(false);
    const full = getTransactionFinancials(
      { totalPayable: 9_700_000, installments: [schedule[0], { ...schedule[1], confirmedPaid: 3_233_333 }, { ...schedule[2] }] },
      NOW
    );
    expect(full.nextInstallment?.number).toBe(2);
    expect(full.isFullyPaid).toBe(false);
  });
});
