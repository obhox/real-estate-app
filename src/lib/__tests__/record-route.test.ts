import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/admin/transactions/[id]/payments: free amount, enforced
// idempotency key, shared validation (hard blocks + acknowledged warnings),
// backdate audit. The old 60-second duplicate window is gone — the unique key
// is the enforcer.

const store = { payments: [] as Record<string, unknown>[], audits: [] as Record<string, unknown>[] };
const txn = {
  id: "txn-1",
  ref: "TXN-1",
  status: "ACTIVE",
  isTest: false,
  totalPayable: 1_000_000,
  outstandingBalance: 1_000_000,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  installments: [
    {
      id: "inst-1",
      transactionId: "txn-1",
      installmentNumber: 1,
      type: "INSTALLMENT",
      dueDate: new Date("2027-01-01T12:00:00.000Z"),
      scheduledAmount: 1_000_000,
      status: "PENDING",
    },
  ],
};

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u1", name: "Admin", email: "admin@x.com", role: "admin" } }),
}));

async function createPayment(args: { data: Record<string, unknown> }) {
  if (args.data.idempotencyKey === "race-key-1") {
    // Simulate losing a create race: winner row exists afterwards.
    store.payments.push({ id: "pay-winner", ...args.data });
    throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
  }
  const row = { id: `pay-${store.payments.length + 1}`, ...args.data };
  store.payments.push(row);
  return row;
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transaction: { findUnique: async () => ({ ...txn }) },
    payment: {
      findUnique: async (args: { where: { idempotencyKey: string } }) =>
        store.payments.find((p) => p.idempotencyKey === args.where.idempotencyKey) ?? null,
      findMany: async () => store.payments.slice(),
      findFirst: async () => null, // ref-gen collision check
      create: createPayment,
    },
    installment: { findMany: async () => txn.installments },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        payment: { create: createPayment },
        auditEvent: {
          create: async (args: unknown) => {
            store.audits.push(args as Record<string, unknown>);
            return {};
          },
        },
      }),
  },
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/admin/transactions/[id]/payments/route";

const ctx = { params: Promise.resolve({ id: "txn-1" }) };

function recordRequest(body: unknown) {
  return new NextRequest("http://localhost/api/admin/transactions/txn-1/payments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0];
}

const base = {
  amount: 400_000,
  paymentDate: new Date().toISOString().slice(0, 10),
  paymentMethod: "Bank Transfer",
  bankReference: "TRF-BASE-1",
  allocationReviewed: true,
};

beforeEach(() => {
  store.payments.length = 0;
  store.audits.length = 0;
});

describe("POST record payment", () => {
  it("requires an idempotency key", async () => {
    const res = await POST(recordRequest({ ...base }), ctx);
    expect(res.status).toBe(400);
    expect(store.payments).toHaveLength(0);
  });

  it("rejects floats and non-positive amounts", async () => {
    for (const amount of [10.5, 0, -5]) {
      const res = await POST(recordRequest({ ...base, amount, idempotencyKey: `k-${amount}` }), ctx);
      expect(res.status).toBe(400);
    }
    expect(store.payments).toHaveLength(0);
  });

  it("rejects amounts above the outstanding balance (the only gate)", async () => {
    const res = await POST(
      recordRequest({ ...base, amount: 1_400_000, idempotencyKey: "over-key-1" }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("outstanding balance") });
    expect(store.payments).toHaveLength(0);
  });

  it("rejects over-outstanding amounts even when sent as credit (no bypass)", async () => {
    const res = await POST(
      recordRequest({ ...base, amount: 1_400_000, idempotencyKey: "over-key-2", asCredit: true }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(store.payments).toHaveLength(0);
  });

  it("accepts amounts exactly at the outstanding balance", async () => {
    const res = await POST(
      recordRequest({ ...base, amount: 1_000_000, idempotencyKey: "exact-key-1" }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(store.payments).toHaveLength(1);
    expect(store.payments[0]).toMatchObject({ amount: 1_000_000, isCredit: false });
  });

  it("records a free (non-scheduled) amount with no installment link", async () => {
    const res = await POST(recordRequest({ ...base, amount: 175_000, idempotencyKey: "free-key-1" }), ctx);
    expect(res.status).toBe(201);
    expect(store.payments).toHaveLength(1);
    expect(store.payments[0]).toMatchObject({
      amount: 175_000,
      installmentId: null,
      status: "PENDING_VERIFICATION",
      idempotencyKey: "free-key-1",
      isCredit: false,
    });
  });

  it("dedupes a repeated key instead of minting a second payment", async () => {
    const first = await POST(recordRequest({ ...base, idempotencyKey: "dbl-key-1" }), ctx);
    expect(first.status).toBe(201);
    const second = await POST(
      recordRequest({ ...base, amount: 999_999, idempotencyKey: "dbl-key-1" }),
      ctx
    );
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ deduped: true });
    expect(store.payments).toHaveLength(1);
    expect(store.payments[0]).toMatchObject({ amount: 400_000 }); // original kept
  });

  it("survives a lost create race via the unique constraint", async () => {
    const res = await POST(recordRequest({ ...base, idempotencyKey: "race-key-1" }), ctx);
    expect(await res.json()).toMatchObject({ deduped: true });
    expect(store.payments).toHaveLength(1);
  });

  it("records within-balance amounts without credit and flags backdating in the audit trail", async () => {
    const res = await POST(
      recordRequest({
        ...base,
        amount: 400_000,
        paymentDate: "2026-01-05",
        idempotencyKey: "credit-key-1",
        asCredit: true,
      }),
      ctx
    );
    expect(res.status).toBe(201);
    expect(store.payments[0]).toMatchObject({ amount: 400_000, isCredit: false, creditAmount: null });
    const audit = store.audits[0].data as Record<string, unknown>;
    const after = audit.after as Record<string, unknown>;
    expect(after).toMatchObject({ asCredit: false, backdated: true });
  });

  it("marks same-day payments as not backdated", async () => {
    await POST(recordRequest({ ...base, idempotencyKey: "today-key-1" }), ctx);
    const after = (store.audits[0].data as Record<string, unknown>).after as Record<string, unknown>;
    expect(after).toMatchObject({ backdated: false });
  });

  it("blocks a Bank Transfer with no reference", async () => {
    const res = await POST(
      recordRequest({ ...base, bankReference: "  ", idempotencyKey: "noref-key-1" }),
      ctx
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("reference is required") });
    expect(store.payments).toHaveLength(0);
  });

  it("blocks a duplicate bank reference on the same transaction", async () => {
    const first = await POST(recordRequest({ ...base, idempotencyKey: "dup-key-1" }), ctx);
    expect(first.status).toBe(201);
    const second = await POST(
      recordRequest({ ...base, bankReference: " trf-base-1 ", idempotencyKey: "dup-key-2" }),
      ctx
    );
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ error: expect.stringContaining("already recorded") });
    expect(store.payments).toHaveLength(1);
  });

  it("blocks a payment dated before the contract or in the future", async () => {
    const before = await POST(
      recordRequest({ ...base, paymentDate: "2025-12-01", idempotencyKey: "date-1" }),
      ctx
    );
    expect(before.status).toBe(400);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const future = await POST(
      recordRequest({ ...base, paymentDate: tomorrow, idempotencyKey: "date-2" }),
      ctx
    );
    expect(future.status).toBe(400);
    expect(store.payments).toHaveLength(0);
  });

  it("requires an acknowledgement before a shortfall/spill is recorded", async () => {
    const res = await POST(
      recordRequest({ ...base, allocationReviewed: false, idempotencyKey: "ack-key-1" }),
      ctx
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ needsAllocationReview: true });
    expect(body.warnings[0].code).toBe("UNDERPAYMENT_SHORTFALL");
    expect(store.payments).toHaveLength(0);
  });
});
