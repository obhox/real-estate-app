import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../schedule-statement-pdf", () => ({
  renderScheduleStatementPdf: vi.fn(async () => Buffer.from("schedule-pdf-bytes")),
}));

vi.mock("../ref", () => ({
  generateUniqueStatementNumber: vi.fn(async () => "STM-2026-99999"),
}));

import { issueScheduleStatement, hashScheduleModel } from "../statements";

const TXN = { id: "t1", ref: "TXN-2026-19362", customerName: "Valentine Nzube Onweluzo", customerEmail: "v@x.com", customerPhone: null, estate: "Sunrise Estate", unitType: "Duplex", plotCode: "SUN-P1", plotQuantity: 1, totalPayable: 7_875_000 };

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

type Row = { id: string; number: string; token: string; closingBalance: number; asAt: Date };
type CreateArg = { data: Record<string, unknown> };

// The slice of PrismaClient issueScheduleStatement touches, plus a fake
// interaction transaction that hands the same object back (the real
// $transaction's shape, self-referential type allowed on an alias property).
type FakeDb = {
  transaction: { findUnique: (a?: unknown) => Promise<typeof TXN | null> };
  installment: { findMany: (a?: unknown) => Promise<typeof INSTALLMENTS> };
  payment: { findMany: (a?: unknown) => Promise<typeof PAYMENTS> };
  statement: {
    findFirst: (a: { where: { kind: string; ledgerHash: string } }) => Promise<unknown>;
    create: (a: CreateArg) => Promise<{ id: string; asAt: Date }>;
  };
  auditEvent: { create: (a: unknown) => Promise<unknown> };
  $transaction: <T>(fn: (tx: FakeDb) => Promise<T>) => Promise<T>;
};

// Mirrors the real repository enough for the lifecycle: findFirst is keyed by
// ledgerHash within a statement store that also remembers each row's `kind`.
function fakeDb() {
  const store: (Row & { kind: string; ledgerHash: string })[] = [];
  const calls = {
    findFirst: [] as unknown[],
    create: [] as CreateArg[],
    audit: [] as unknown[],
    order: [] as string[],
  };
  const api: FakeDb = {
    transaction: { findUnique: async () => TXN },
    installment: { findMany: async () => INSTALLMENTS },
    payment: { findMany: async () => PAYMENTS },
    statement: {
      findFirst: async (args: { where: { kind: string; ledgerHash: string } }) => {
        calls.findFirst.push(args);
        calls.order.push("findFirst");
        const hit = store.find((r) => r.kind === args.where.kind && r.ledgerHash === args.where.ledgerHash);
        return hit ?? null;
      },
      create: async (args: CreateArg) => {
        calls.create.push(args);
        calls.order.push("create");
        const d = args.data as { number: string; token: string; closingBalance: number; kind: string; ledgerHash: string };
        const row: Row & { kind: string; ledgerHash: string } = {
          id: `s${store.length + 1}`,
          number: d.number,
          token: d.token,
          closingBalance: d.closingBalance,
          asAt: new Date("2026-11-01T12:00:00Z"),
          kind: d.kind,
          ledgerHash: d.ledgerHash,
        };
        store.push(row);
        return { id: row.id, asAt: row.asAt };
      },
    },
    auditEvent: { create: async (args: unknown) => { calls.audit.push(args); return {}; } },
    $transaction: async <T>(fn: (tx: typeof api) => Promise<T>) => fn(api),
  };
  return { api, store, calls };
}

beforeEach(() => vi.clearAllMocks());

describe("hashScheduleModel", () => {
  it("changes when a received amount changes, stays stable otherwise", () => {
    const base = {
      rows: [{ dueDate: "14-10-2026", scheduled: 100, received: 100, status: "Paid" }],
      totals: { scheduled: 100, received: 100, outstanding: 0, credit: 0 },
      layoutVersion: "sched-v1",
    };
    const a = hashScheduleModel(base);
    expect(hashScheduleModel(base)).toBe(a);
    expect(
      hashScheduleModel({ ...base, rows: [{ dueDate: "14-10-2026", scheduled: 100, received: 50, status: "Part paid" }] })
    ).not.toBe(a);
  });
});

describe("issueScheduleStatement", () => {
  it("issues a SCHEDULE statement with outstanding as the closing balance", async () => {
    const { api, calls } = fakeDb();
    const res = await issueScheduleStatement(api as never, { transactionId: "t1", actorName: "Ada" });
    expect(res.created).toBe(true);
    expect(res.statement.number).toBe("STM-2026-99999");
    expect(res.statement.closingBalance).toBe(1_937_500);
    const data = calls.create[0].data as { kind: string; closingBalance: number };
    expect(data.kind).toBe("SCHEDULE");
    expect(data.closingBalance).toBe(1_937_500);
    expect((calls.audit[0] as { data: { action: string } }).data.action).toBe("schedule_statement.generate");
  });

  it("returns the existing statement when the schedule state is unchanged", async () => {
    const { api, store } = fakeDb();
    const first = await issueScheduleStatement(api as never, { transactionId: "t1" });
    const second = await issueScheduleStatement(api as never, { transactionId: "t1" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.statement.id).toBe(first.statement.id);
    expect(store).toHaveLength(1);
  });

  it("scopes the dedupe lookup to kind SCHEDULE (never reuses a ledger statement)", async () => {
    const { api, calls } = fakeDb();
    await issueScheduleStatement(api as never, { transactionId: "t1" });
    const where = (calls.findFirst[0] as { where: { kind: string } }).where;
    expect(where.kind).toBe("SCHEDULE");
  });

  it("blocks issue when the installment plan does not sum to the total payable", async () => {
    const { api } = fakeDb();
    api.installment.findMany = async () => INSTALLMENTS.slice(0, 6);
    await expect(issueScheduleStatement(api as never, { transactionId: "t1" })).rejects.toThrow(/data check failed/);
  });

  it("throws for an unknown transaction", async () => {
    const { api } = fakeDb();
    api.transaction.findUnique = async () => null;
    await expect(issueScheduleStatement(api as never, { transactionId: "nope" })).rejects.toThrow("Transaction not found");
  });
});
