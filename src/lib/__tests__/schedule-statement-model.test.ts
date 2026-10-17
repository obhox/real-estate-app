import { describe, it, expect } from "vitest";
import { buildScheduleStatementModel, type ScheduleStatementModelDb } from "../schedule-statement-model";

const TXN = {
  id: "t1",
  ref: "TXN-2026-19362",
  customerName: "Valentine Nzube Onweluzo",
  customerEmail: "v@x.com",
  customerPhone: "+2348000000000",
  estate: "Sunrise Estate",
  unitType: "5-Bedroom Duplex + BQ",
  plotCode: "SUN-P1-500SQM",
  plotQuantity: 1,
  totalPayable: 7_875_000,
};

const INSTALLMENTS = [
  { id: "i0", installmentNumber: 0, type: "INITIAL", dueDate: new Date("2026-10-14T12:00:00Z"), scheduledAmount: 3_937_500 },
  { id: "i1", installmentNumber: 1, type: "MONTHLY", dueDate: new Date("2026-12-14T12:00:00Z"), scheduledAmount: 656_250 },
  { id: "i2", installmentNumber: 2, type: "MONTHLY", dueDate: new Date("2027-01-14T12:00:00Z"), scheduledAmount: 656_250 },
  { id: "i3", installmentNumber: 3, type: "MONTHLY", dueDate: new Date("2027-02-14T12:00:00Z"), scheduledAmount: 656_250 },
  { id: "i4", installmentNumber: 4, type: "MONTHLY", dueDate: new Date("2027-03-14T12:00:00Z"), scheduledAmount: 656_250 },
  { id: "i5", installmentNumber: 5, type: "MONTHLY", dueDate: new Date("2027-04-14T12:00:00Z"), scheduledAmount: 656_250 },
  { id: "i6", installmentNumber: 6, type: "MONTHLY", dueDate: new Date("2027-05-14T12:00:00Z"), scheduledAmount: 656_250 },
];

const PAYMENTS = [
  { id: "p1", amount: 3_937_500, status: "CONFIRMED", paymentDate: new Date("2026-10-14T12:00:00Z") },
  { id: "p2", amount: 1_000_000, status: "CONFIRMED", paymentDate: new Date("2026-10-15T12:00:00Z") },
  { id: "p3", amount: 1_000_000, status: "CONFIRMED", paymentDate: new Date("2026-10-16T12:00:00Z") },
];

function fakeDb(over: {
  txn?: Record<string, unknown> | null;
  installments?: typeof INSTALLMENTS;
  payments?: typeof PAYMENTS;
} = {}): ScheduleStatementModelDb {
  return {
    transaction: {
      findUnique: async () => (over.txn === null ? null : { ...TXN, ...(over.txn ?? {}) }),
    },
    installment: { findMany: async () => over.installments ?? INSTALLMENTS },
    payment: { findMany: async () => over.payments ?? PAYMENTS },
  } as never;
}

describe("buildScheduleStatementModel", () => {
  it("builds the real bug transaction's schedule with no data-check errors", async () => {
    const m = await buildScheduleStatementModel(fakeDb(), {
      transactionId: "t1",
      draft: false,
      number: "STMT-2026-0001",
      asOf: new Date("2026-11-01T12:00:00Z"),
    });
    expect(m.accountRef).toBe("TXN-2026-19362");
    expect(m.number).toBe("STMT-2026-0001");
    expect(m.dataCheckErrors).toEqual([]);
    expect(m.totals).toMatchObject({ scheduled: 7_875_000, received: 5_937_500, outstanding: 1_937_500 });
    expect(m.nextDue).toMatchObject({ label: "Month 4 payment", amount: 625_000 });
    expect(m.client.name).toBe("Valentine Nzube Onweluzo");
    expect(m.property.sku).toBe("SUN-P1-500SQM");
  });

  it("omits the statement number while a draft", async () => {
    const m = await buildScheduleStatementModel(fakeDb(), { transactionId: "t1", draft: true });
    expect(m.isDraft).toBe(true);
    expect(m.number).toBeUndefined();
  });

  it("flags a plan whose installments do not sum to the transaction total payable", async () => {
    const bad = INSTALLMENTS.slice(0, 6).map((i) => ({ ...i }));
    const m = await buildScheduleStatementModel(fakeDb({ installments: bad as typeof INSTALLMENTS }), {
      transactionId: "t1",
      draft: true,
    });
    expect(m.dataCheckErrors).toHaveLength(1);
    expect(m.dataCheckErrors[0]).toMatch(/total payable/);
  });

  it("flags a transaction with no installments", async () => {
    const m = await buildScheduleStatementModel(fakeDb({ installments: [] }), {
      transactionId: "t1",
      draft: true,
    });
    expect(m.dataCheckErrors.join(" ")).toMatch(/no payment plan/);
  });

  it("throws for an unknown transaction", async () => {
    await expect(
      buildScheduleStatementModel(fakeDb({ txn: null }), { transactionId: "nope", draft: true })
    ).rejects.toThrow("Transaction not found");
  });
});
