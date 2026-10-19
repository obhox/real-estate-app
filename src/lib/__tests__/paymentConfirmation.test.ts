import { describe, it, expect } from "vitest";
import {
  deriveInstallmentStatus,
  wouldExceedSchedule,
  applyConfirmationDbUnit,
  reverseConfirmedPaymentDbUnit,
  toUserFacingError,
  isTransientDbError,
  PaymentAlreadyHandledError,
  OverScheduleError,
  TotalBalanceExceededError,
  type TxClient,
} from "../paymentConfirmation";

// ---- In-memory mock of the tx client (stateful, so race/idempotency hold) ----

type MockPayment = {
  id: string;
  transactionId: string;
  status: string;
  amount: number;
  paymentDate: Date;
  paymentMethod: string | null;
  bankReference?: string | null;
  installmentId: string | null;
  isCredit?: boolean;
  creditAmount?: number | null;
  confirmedAt?: Date | null;
  confirmedById?: string | null;
  verificationNotes?: string | null;
  updatedAt?: Date;
};

type MockInstallment = {
  id: string;
  transactionId: string;
  installmentNumber: number;
  type: string;
  dueDate: Date;
  scheduledAmount: number;
  paidAmount: number;
  status: string;
};

type MockTransaction = {
  id: string;
  ref: string;
  bookingId: string | null;
  customerName: string;
  customerEmail: string;
  customerPhone: string | null;
  estate: string;
  unitType: string | null;
  plotCode: string | null;
  sqm: number | null;
  baseAmount: number;
  unitPrice: number;
  plotQuantity: number;
  interestAmount: number;
  totalPayable: number;
  totalPaid: number;
  outstandingBalance: number;
  status: string;
  paymentPlan: { code: string; name: string } | null;
  installments: MockInstallment[];
};

type MockState = {
  payments: MockPayment[];
  installments: MockInstallment[];
  transactions: MockTransaction[];
  receipts: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  allocs: Record<string, unknown>[];
  audits: Record<string, unknown>[];
  bookings: { id: string; status: string; outcome: string | null }[];
  activities: Record<string, unknown>[];
};

function makeMockTx(state: MockState): TxClient {
  const findPayment = (id: string) => state.payments.find((p) => p.id === id) ?? null;
  const attachTransaction = (p: MockPayment) => {
    const t = state.transactions.find((t) => t.id === p.transactionId);
    if (!t) return null;
    return { ...p, transaction: t };
  };
  return {
    payment: {
      updateMany: async (args: unknown) => {
        const { where, data } = args as {
          where: { id: string; transactionId: string; status: string };
          data: Record<string, unknown>;
        };
        const p = state.payments.find(
          (x) => x.id === where.id && x.transactionId === where.transactionId && x.status === where.status
        );
        if (!p) return { count: 0 };
        Object.assign(p, data);
        return { count: 1 };
      },
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        const p = findPayment(where.id);
        return p ? attachTransaction(p) : null;
      },
      findMany: async (args: unknown) => {
        const { where } = args as { where: { transactionId: string; status: string } };
        return state.payments.filter((p) => p.transactionId === where.transactionId && p.status === where.status);
      },
      findFirst: async (args: unknown) => {
        const { where } = args as { where: { transactionId: string; status: string; isCredit?: boolean } };
        return (
          state.payments.find(
            (p) =>
              p.transactionId === where.transactionId &&
              p.status === where.status &&
              (where.isCredit === undefined || !!p.isCredit === where.isCredit)
          ) ?? null
        );
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
        const p = findPayment(where.id);
        if (!p) throw new Error("not found");
        Object.assign(p, data);
        return p;
      },
    },
    installment: {
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        return state.installments.find((i) => i.id === where.id) ?? null;
      },
      findMany: async (args: unknown) => {
        const { where } = args as { where: { transactionId: string } };
        return state.installments
          .filter((i) => i.transactionId === where.transactionId)
          .sort((a, b) => a.installmentNumber - b.installmentNumber);
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
        const inst = state.installments.find((i) => i.id === where.id);
        if (!inst) throw new Error("not found");
        Object.assign(inst, data);
        return inst;
      },
      updateMany: async (args: unknown) => {
        const { where, data } = args as {
          where: { transactionId: string; status: { not?: string; notIn?: string[] } };
          data: Record<string, unknown>;
        };
        let count = 0;
        for (const inst of state.installments) {
          if (inst.transactionId !== where.transactionId) continue;
          const s = where.status;
          const matches =
            s.not !== undefined
              ? inst.status !== s.not
              : Array.isArray(s.notIn)
                ? !s.notIn.includes(inst.status)
                : true;
          if (matches) {
            Object.assign(inst, data);
            count++;
          }
        }
        return { count };
      },
    },
    transaction: {
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        return state.transactions.find((t) => t.id === where.id) ?? null;
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
        const t = state.transactions.find((x) => x.id === where.id);
        if (!t) throw new Error("not found");
        Object.assign(t, data);
        return t;
      },
    },
    receipt: {
      create: async (args: unknown) => {
        const { data } = args as { data: Record<string, unknown> };
        const row = { id: `rcpt-${state.receipts.length + 1}`, ...data };
        state.receipts.push(row);
        return row;
      },
    },
    ledgerEntry: {
      create: async (args: unknown) => {
        const { data } = args as { data: Record<string, unknown> };
        const row = { id: `le-${state.ledger.length + 1}`, ...data };
        state.ledger.push(row);
        return row;
      },
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { paymentId?: string } };
        return state.ledger.find((e) => (e as { paymentId?: string }).paymentId === where.paymentId) ?? null;
      },
    },
    paymentAllocation: {
      create: async (args: unknown) => {
        const { data } = args as { data: Record<string, unknown> };
        const row = { id: `pa-${state.allocs.length + 1}`, ...data };
        state.allocs.push(row);
        return row;
      },
      findMany: async (args: unknown) => {
        const { where } = args as { where: { paymentId: string | { in: string[] } } };
        const pid = where.paymentId;
        const ids = typeof pid === "string" ? [pid] : pid.in;
        return state.allocs.filter((a) => ids.includes((a as { paymentId: string }).paymentId));
      },
      deleteMany: async (args: unknown) => {
        const { where } = args as { where: { paymentId: string | { in: string[] } } };
        const pid = where.paymentId;
        const ids = typeof pid === "string" ? [pid] : pid.in;
        const before = state.allocs.length;
        state.allocs = state.allocs.filter(
          (a) => !ids.includes((a as { paymentId: string }).paymentId)
        );
        return { count: before - state.allocs.length };
      },
    },
    auditEvent: {
      create: async (args: unknown) => {
        const { data } = args as { data: Record<string, unknown> };
        const row = { id: `aud-${state.audits.length + 1}`, ...data };
        state.audits.push(row);
        return row;
      },
    },
    inspectionBooking: {
      findUnique: async (args: unknown) => {
        const { where } = args as { where: { id: string } };
        return state.bookings.find((b) => b.id === where.id) ?? null;
      },
      update: async (args: unknown) => {
        const { where, data } = args as { where: { id: string }; data: Record<string, unknown> };
        const b = state.bookings.find((x) => x.id === where.id);
        if (!b) throw new Error("not found");
        Object.assign(b, data);
        return b;
      },
    },
    bookingActivity: {
      create: async (args: unknown) => {
        const { data } = args as { data: Record<string, unknown> };
        const row = { id: `act-${state.activities.length + 1}`, ...data };
        state.activities.push(row);
        return row;
      },
    },
  } as unknown as TxClient;
}

function seed2900(): MockState {
  const installment: MockInstallment = {
    id: "inst-0",
    transactionId: "txn-1",
    installmentNumber: 0,
    type: "INITIAL",
    dueDate: new Date("2026-01-01T00:00:00Z"),
    scheduledAmount: 2_900_000,
    paidAmount: 0,
    status: "DUE",
  };
  const transaction: MockTransaction = {
    id: "txn-1",
    ref: "TXN-2026-00001",
    bookingId: null,
    customerName: "Test Client",
    customerEmail: "test@example.com",
    customerPhone: null,
    estate: "Test Estate",
    unitType: "Plot",
    plotCode: "TST-200",
    sqm: 200,
    baseAmount: 2_900_000,
    unitPrice: 2_900_000,
    plotQuantity: 1,
    interestAmount: 0,
    totalPayable: 2_900_000,
    totalPaid: 0,
    outstandingBalance: 2_900_000,
    status: "ACTIVE",
    paymentPlan: { code: "OUTRIGHT", name: "Outright" },
    installments: [installment],
  };
  return { payments: [], installments: [installment], transactions: [transaction], receipts: [], ledger: [], allocs: [], audits: [], bookings: [], activities: [] };
}

function pendingPayment(id: string): MockPayment {
  return {
    id,
    transactionId: "txn-1",
    status: "PENDING_VERIFICATION",
    amount: 2_900_000,
    paymentDate: new Date("2026-02-01T00:00:00Z"),
    paymentMethod: "Bank Transfer",
    installmentId: "inst-0",
  };
}

const REF_BASE = {
  receiptRef: "BEL-2026-00001",
  receiptUrl: "https://example.com/r/test-access-token-00001",
  qrTargetUrl: "https://example.com/r/test-access-token-00001",
  pdfPath: "storage/receipts/BEL-2026-00001.pdf",
  accessToken: "test-access-token-00001",
};

describe("deriveInstallmentStatus", () => {
  const past = new Date("2026-01-01T00:00:00Z");
  const future = new Date("2027-01-01T00:00:00Z");
  const now = new Date("2026-06-01T00:00:00Z");

  it("is Paid only when confirmed money covers the schedule", () => {
    expect(deriveInstallmentStatus(2_900_000, 2_900_000, past, now)).toBe("PAID");
  });

  it("is Late when past due and confirmed paid < scheduled (pending counts as nothing)", () => {
    // A pending ₦2.9M must NOT move this off Late — only confirmed 0 counts.
    expect(deriveInstallmentStatus(0, 2_900_000, past, now)).toBe("OVERDUE");
    expect(deriveInstallmentStatus(1_000_000, 2_900_000, past, now)).toBe("OVERDUE");
  });

  it("is Partial when some confirmed money exists and due date is future", () => {
    expect(deriveInstallmentStatus(1_000_000, 2_900_000, future, now)).toBe("PARTIALLY_PAID");
  });

  it("is Due today, Pending for future dates", () => {
    expect(deriveInstallmentStatus(0, 2_900_000, now, now)).toBe("DUE");
    expect(deriveInstallmentStatus(0, 2_900_000, future, now)).toBe("PENDING");
  });
});

describe("wouldExceedSchedule", () => {
  it("rejects three identical pending payments against one installment (the reported bug)", () => {
    // First two pending (confirmed 0 + pending 2.9M... simulate sequentially):
    expect(wouldExceedSchedule(0, 0, 2_900_000, 2_900_000)).toBe(false); // 1st ok
    expect(wouldExceedSchedule(0, 2_900_000, 2_900_000, 2_900_000)).toBe(true); // 2nd rejected
    expect(wouldExceedSchedule(0, 5_800_000, 2_900_000, 2_900_000)).toBe(true); // 3rd rejected
  });

  it("allows exact fit and partials", () => {
    expect(wouldExceedSchedule(1_000_000, 0, 1_900_000, 2_900_000)).toBe(false);
    expect(wouldExceedSchedule(1_000_000, 0, 1_900_001, 2_900_000)).toBe(true);
  });
});

describe("applyConfirmationDbUnit", () => {
  it("confirms once: moves installment, totals, and creates exactly one receipt", async () => {
    const state = seed2900();
    state.payments.push(pendingPayment("pay-1"));
    const tx = makeMockTx(state);

    const result = await applyConfirmationDbUnit(tx, {
      paymentId: "pay-1",
      transactionId: "txn-1",
      ...REF_BASE,
    });

    expect(result.newTotalPaid).toBe(2_900_000);
    expect(result.newOutstanding).toBe(0);
    expect(result.isPaidInFull).toBe(true);
    expect(state.installments[0].status).toBe("PAID");
    expect(state.installments[0].paidAmount).toBe(2_900_000);
    expect(state.transactions[0].status).toBe("PAID_IN_FULL");
    expect(state.receipts).toHaveLength(1);
    expect((state.receipts[0] as { pdfStatus: string }).pdfStatus).toBe("PENDING");
    expect((state.receipts[0] as { paymentId: string }).paymentId).toBe("pay-1");
    // Receipt email queued in the SAME atomic unit (no post-commit enqueue).
    expect(state.receipts).toHaveLength(1);
    expect((state.receipts[0] as { source: string }).source).toBe("PAYMENT_CONFIRMATION");
    // Audit row written in the same unit.
    expect(state.audits).toHaveLength(1);
    expect((state.audits[0] as { action: string }).action).toBe("payment.confirm");
    expect((state.audits[0] as { entityId: string }).entityId).toBe("pay-1");
    // Ledger dual-write in the same unit: one PAYMENT entry + allocations
    // summing exactly to the payment amount.
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      type: "PAYMENT",
      direction: "CREDIT",
      amount: 2_900_000,
      paymentId: "pay-1",
      idempotencyKey: "payment:pay-1",
    });
    expect(state.allocs).toHaveLength(1);
    expect(state.allocs[0]).toMatchObject({ paymentId: "pay-1", installmentId: "inst-0", amount: 2_900_000 });
  });

  it("double-confirm applies only once (idempotent claim)", async () => {
    const state = seed2900();
    state.payments.push(pendingPayment("pay-1"));
    const tx = makeMockTx(state);

    await applyConfirmationDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1", ...REF_BASE });
    await expect(
      applyConfirmationDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1", ...REF_BASE })
    ).rejects.toBeInstanceOf(PaymentAlreadyHandledError);

    expect(state.transactions[0].totalPaid).toBe(2_900_000); // not doubled
    expect(state.receipts).toHaveLength(1); // no second receipt
  });

  it("confirms beyond the scheduled amount: capped allocation, excess parked as credit", async () => {
    // Schedule is smaller than the amount payable (a fee/premium outside the
    // plan), so a payment that clears the plan leaves a genuine credit balance.
    const state = seed2900();
    state.installments[0].scheduledAmount = 2_300_000;
    state.payments.push({ ...pendingPayment("pay-2"), amount: 2_900_000 });
    const tx = makeMockTx(state);

    const result = await applyConfirmationDbUnit(tx, { paymentId: "pay-2", transactionId: "txn-1", ...REF_BASE });

    // 2.3M of schedule capacity filled, 600k parked as visible credit.
    expect(result.newTotalPaid).toBe(2_900_000);
    expect(result.newOutstanding).toBe(0);
    expect(result.isPaidInFull).toBe(true);
    expect(state.installments[0].paidAmount).toBe(2_300_000);
    expect(state.installments[0].status).toBe("PAID");
    expect(state.payments.find((p) => p.id === "pay-2")).toMatchObject({ isCredit: true, creditAmount: 600_000 });
    expect(state.receipts).toHaveLength(1);
    const allocSum = state.allocs.reduce((s, a) => s + ((a as { amount: number }).amount), 0);
    expect(allocSum).toBe(2_300_000);
  });

  it("over-balance payment is rejected even when explicitly marked credit", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-9"), amount: 3_400_000, isCredit: true });
    const tx = makeMockTx(state);

    await expect(
      applyConfirmationDbUnit(tx, { paymentId: "pay-9", transactionId: "txn-1", ...REF_BASE })
    ).rejects.toBeInstanceOf(TotalBalanceExceededError);

    // Nothing written: no ledger entry, no receipt, no totals moved.
    // (The mock has no rollback so the claim flip stays; production rolls the
    // whole unit back. Only no-partial-write guarantees are asserted here.)
    expect(state.ledger).toHaveLength(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.transactions[0].totalPaid).toBe(0);
    expect(state.installments[0].paidAmount).toBe(0);
  });

  it("over-balance payment is rejected without any credit flag", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-9"), amount: 3_400_000, isCredit: false });
    const tx = makeMockTx(state);

    await expect(
      applyConfirmationDbUnit(tx, { paymentId: "pay-9", transactionId: "txn-1", ...REF_BASE })
    ).rejects.toBeInstanceOf(TotalBalanceExceededError);

    expect(state.ledger).toHaveLength(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.transactions[0].totalPaid).toBe(0);
    expect(state.installments[0].paidAmount).toBe(0);
  });
});

describe("reverseConfirmedPaymentDbUnit", () => {
  it("void reverses installment and totals, receipt stays for audit", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED" });
    state.installments[0].paidAmount = 2_900_000;
    state.installments[0].status = "PAID";
    state.transactions[0].totalPaid = 2_900_000;
    state.transactions[0].outstandingBalance = 0;
    state.transactions[0].status = "PAID_IN_FULL";
    state.receipts.push({ id: "rcpt-1", paymentId: "pay-1" });
    const tx = makeMockTx(state);

    const result = await reverseConfirmedPaymentDbUnit(tx, {
      paymentId: "pay-1",
      transactionId: "txn-1",
      reason: "duplicate entry",
    });

    expect(result.newTotalPaid).toBe(0);
    expect(result.newOutstanding).toBe(2_900_000);
    expect(state.transactions[0].status).toBe("ACTIVE");
    expect(state.installments[0].paidAmount).toBe(0);
    expect(state.installments[0].status).toBe("OVERDUE"); // past due, nothing confirmed
    expect(state.payments[0].status).toBe("CANCELLED");
    expect(state.receipts).toHaveLength(1); // audit trail kept
    expect(state.audits.map((a) => (a as { action: string }).action)).toContain("payment.void");
  });

  it("void appends a REVERSAL entry and drops the payment's allocations", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED" });
    state.installments[0].paidAmount = 2_900_000;
    state.installments[0].status = "PAID";
    state.transactions[0].totalPaid = 2_900_000;
    state.transactions[0].outstandingBalance = 0;
    state.transactions[0].status = "PAID_IN_FULL";
    state.ledger.push({ id: "le-1", type: "PAYMENT", amount: 2_900_000, paymentId: "pay-1" });
    state.allocs.push({ id: "pa-1", paymentId: "pay-1", installmentId: "inst-0", amount: 2_900_000 });
    const tx = makeMockTx(state);

    await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1", reason: "dup" });

    expect(state.ledger).toHaveLength(2);
    expect(state.ledger[1]).toMatchObject({
      type: "REVERSAL",
      direction: "DEBIT",
      amount: 2_900_000,
      reversesEntryId: "le-1",
      idempotencyKey: "reversal:pay-1",
    });
    expect(state.allocs).toHaveLength(0);
  });

  it("void of a pre-ledger payment still reverses stored totals (no entry to reverse)", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED" });
    state.installments[0].paidAmount = 2_900_000;
    state.installments[0].status = "PAID";
    state.transactions[0].totalPaid = 2_900_000;
    state.transactions[0].outstandingBalance = 0;
    const tx = makeMockTx(state);

    const result = await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1" });

    expect(result.newTotalPaid).toBe(0);
    expect(state.ledger).toHaveLength(0); // nothing to reverse; stored path still applied
  });

  it("second void aborts (already handled)", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED" });
    state.installments[0].paidAmount = 2_900_000;
    state.installments[0].status = "PAID";
    state.transactions[0].totalPaid = 2_900_000;
    state.transactions[0].outstandingBalance = 0;
    const tx = makeMockTx(state);

    await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1" });
    await expect(
      reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1" })
    ).rejects.toBeInstanceOf(PaymentAlreadyHandledError);
  });

  it("voiding the last confirmed payment reverts an auto-sold booking to interested", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED" });
    state.installments[0].paidAmount = 2_900_000;
    state.installments[0].status = "PAID";
    state.transactions[0].totalPaid = 2_900_000;
    state.transactions[0].outstandingBalance = 0;
    state.transactions[0].status = "PAID_IN_FULL";
    state.transactions[0].bookingId = "book-1";
    state.bookings.push({ id: "book-1", status: "active", outcome: "sold" });
    const tx = makeMockTx(state);

    const result = await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1" });

    expect(result.newTotalPaid).toBe(0);
    expect(state.bookings[0].outcome).toBe("interested");
    expect(state.activities).toHaveLength(1);
    expect((state.activities[0] as { action: string }).action).toBe("record_outcome");
  });

  it("voiding one of several confirmed payments leaves a sold booking alone", async () => {
    const state = seed2900();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED" });
    state.payments.push({ ...pendingPayment("pay-2"), status: "CONFIRMED", amount: 1_000_000 });
    state.installments[0].paidAmount = 2_900_000;
    state.transactions[0].totalPaid = 2_900_000;
    state.transactions[0].bookingId = "book-1";
    state.bookings.push({ id: "book-1", status: "active", outcome: "sold" });
    const tx = makeMockTx(state);

    // Void a smaller payment so confirmed money remains.
    state.payments[1].amount = 1_000_000;
    const result = await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-2", transactionId: "txn-1" });

    expect(result.newTotalPaid).toBe(2_900_000);
    expect(state.bookings[0].outcome).toBe("sold");
    expect(state.activities).toHaveLength(0);
  });
});

function seedSplit(): MockState {
  const future = new Date("2027-01-01T00:00:00Z");
  const i0: MockInstallment = {
    id: "inst-0",
    transactionId: "txn-1",
    installmentNumber: 0,
    type: "INITIAL",
    dueDate: new Date("2026-01-01T00:00:00Z"),
    scheduledAmount: 4_000_000,
    paidAmount: 0,
    status: "DUE",
  };
  const i1: MockInstallment = {
    id: "inst-1",
    transactionId: "txn-1",
    installmentNumber: 1,
    type: "MONTHLY",
    dueDate: future,
    scheduledAmount: 6_000_000,
    paidAmount: 0,
    status: "PENDING",
  };
  const transaction: MockTransaction = {
    id: "txn-1",
    ref: "TXN-2026-00002",
    bookingId: null,
    customerName: "Test Client",
    customerEmail: "test@example.com",
    customerPhone: null,
    estate: "Test Estate",
    unitType: "Plot",
    plotCode: "TST-200",
    sqm: 200,
    baseAmount: 10_000_000,
    unitPrice: 10_000_000,
    plotQuantity: 1,
    interestAmount: 0,
    totalPayable: 10_000_000,
    totalPaid: 0,
    outstandingBalance: 10_000_000,
    status: "ACTIVE",
    paymentPlan: { code: "3M", name: "0-3 Months" },
    installments: [i0, i1],
  };
  return { payments: [], installments: [i0, i1], transactions: [transaction], receipts: [], ledger: [], allocs: [], audits: [], bookings: [], activities: [] };
}

describe("waterfall allocation", () => {
  it("excess over the targeted installment rolls into the next one", async () => {
    const state = seedSplit();
    state.payments.push({ ...pendingPayment("pay-1"), amount: 7_000_000 });
    const tx = makeMockTx(state);

    const result = await applyConfirmationDbUnit(tx, {
      paymentId: "pay-1",
      transactionId: "txn-1",
      ...REF_BASE,
    });

    expect(result.newTotalPaid).toBe(7_000_000);
    expect(result.newOutstanding).toBe(3_000_000);
    expect(result.isPaidInFull).toBe(false);
    expect(state.installments[0].paidAmount).toBe(4_000_000);
    expect(state.installments[0].status).toBe("PAID");
    expect(state.installments[1].paidAmount).toBe(3_000_000);
    expect(state.installments[1].status).toBe("PARTIALLY_PAID");
    // Receipt still references the targeted installment.
    expect(result.installment?.id).toBe("inst-0");
    expect(state.transactions[0].status).toBe("ACTIVE");
    expect(state.receipts).toHaveLength(1);
  });

  it("a payment filling two installments to the naira flips the transaction to Paid Full", async () => {
    const state = seedSplit();
    state.payments.push({ ...pendingPayment("pay-1"), amount: 10_000_000 });
    const tx = makeMockTx(state);

    const result = await applyConfirmationDbUnit(tx, {
      paymentId: "pay-1",
      transactionId: "txn-1",
      ...REF_BASE,
    });

    expect(result.isPaidInFull).toBe(true);
    expect(state.installments[0].status).toBe("PAID");
    expect(state.installments[1].status).toBe("PAID");
    expect(state.transactions[0].status).toBe("PAID_IN_FULL");
  });

  it("excess past the final installment is rejected when it exceeds the total balance", async () => {
    const state = seedSplit();
    state.payments.push({ ...pendingPayment("pay-1"), amount: 11_000_000 });
    const tx = makeMockTx(state);

    await expect(
      applyConfirmationDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1", ...REF_BASE })
    ).rejects.toBeInstanceOf(TotalBalanceExceededError);

    expect(state.ledger).toHaveLength(0);
    expect(state.receipts).toHaveLength(0);
    expect(state.transactions[0].totalPaid).toBe(0);
    expect(state.installments[0].paidAmount).toBe(0);
    expect(state.installments[1].paidAmount).toBe(0);
  });

  it("reversing a waterfall payment restores both buckets and Active status", async () => {
    const state = seedSplit();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED", amount: 7_000_000 });
    state.installments[0].paidAmount = 4_000_000;
    state.installments[0].status = "PAID";
    state.installments[1].paidAmount = 3_000_000;
    state.installments[1].status = "PARTIALLY_PAID";
    state.transactions[0].totalPaid = 7_000_000;
    state.transactions[0].outstandingBalance = 3_000_000;
    const tx = makeMockTx(state);

    const result = await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1" });

    expect(result.newTotalPaid).toBe(0);
    expect(result.newOutstanding).toBe(10_000_000);
    expect(state.installments[0].paidAmount).toBe(0);
    expect(state.installments[1].paidAmount).toBe(0);
    expect(state.transactions[0].status).toBe("ACTIVE");
  });

  it("reversal preserves DRAFT instead of promoting to Active", async () => {
    const state = seedSplit();
    state.payments.push({ ...pendingPayment("pay-1"), status: "CONFIRMED", amount: 4_000_000 });
    state.installments[0].paidAmount = 4_000_000;
    state.installments[0].status = "PAID";
    state.transactions[0].totalPaid = 4_000_000;
    state.transactions[0].outstandingBalance = 6_000_000;
    state.transactions[0].status = "DRAFT";
    const tx = makeMockTx(state);

    await reverseConfirmedPaymentDbUnit(tx, { paymentId: "pay-1", transactionId: "txn-1" });

    expect(state.transactions[0].status).toBe("DRAFT");
  });
});

// ---------------------------------------------------------------------------
// Total-balance gate, parametrized across multiple account shapes (never one).
// Shapes mirror real accounts: outright single-installment, multi-installment
// split, near-full, and a Sandra-shaped account (prior credit parking,
// CANCELLED correction history, forced PAID labels on underpaid rows).
// The gate rule is identical for all of them: existing confirmed total +
// new payment > totalPayable -> reject; anything at or below -> accept.
// ---------------------------------------------------------------------------

type GateInstSpec = { n: number; type: string; scheduled: number; paid: number; status: string };
type GatePaySpec = { id: string; amount: number; inst: string | null; isCredit?: boolean; credit?: number | null };

function seedGateAccount(opts: {
  ref: string;
  total: number;
  installments: GateInstSpec[];
  confirmed: GatePaySpec[];
  cancelled?: { id: string; amount: number }[];
}): MockState {
  const installments: MockInstallment[] = opts.installments.map((s, idx) => ({
    id: `inst-${idx}`,
    transactionId: "txn-1",
    installmentNumber: s.n,
    type: s.type,
    dueDate: new Date(s.n === 0 ? "2026-01-01T00:00:00Z" : "2027-01-01T00:00:00Z"),
    scheduledAmount: s.scheduled,
    paidAmount: s.paid,
    status: s.status,
  }));
  const payments: MockPayment[] = [
    ...opts.confirmed.map((p) => ({
      id: p.id,
      transactionId: "txn-1",
      status: "CONFIRMED",
      amount: p.amount,
      paymentDate: new Date("2026-02-01T00:00:00Z"),
      paymentMethod: "Bank Transfer" as string | null,
      installmentId: p.inst,
      isCredit: p.isCredit,
      creditAmount: p.credit ?? null,
    })),
    ...(opts.cancelled ?? []).map((p) => ({
      id: p.id,
      transactionId: "txn-1",
      status: "CANCELLED",
      amount: p.amount,
      paymentDate: new Date("2026-02-01T00:00:00Z"),
      paymentMethod: "Bank Transfer" as string | null,
      installmentId: null as string | null,
    })),
  ];
  const paidSum = opts.confirmed.reduce((s, p) => s + p.amount, 0);
  const transaction: MockTransaction = {
    id: "txn-1",
    ref: opts.ref,
    bookingId: null,
    customerName: "Gate Test",
    customerEmail: "gate@example.com",
    customerPhone: null,
    estate: "Test Estate",
    unitType: "Plot",
    plotCode: "TST-200",
    sqm: 200,
    baseAmount: opts.total,
    unitPrice: opts.total,
    plotQuantity: 1,
    interestAmount: 0,
    totalPayable: opts.total,
    totalPaid: paidSum,
    outstandingBalance: opts.total - paidSum,
    status: paidSum >= opts.total ? "PAID_IN_FULL" : "ACTIVE",
    paymentPlan: { code: "TEST", name: "Test" },
    installments,
  };
  // Pre-existing confirmed payments carry their ledger entry + allocations,
  // with per-installment allocation sums matching stored paidAmount.
  const ledger: Record<string, unknown>[] = opts.confirmed.map((p, i) => ({
    id: `le-seed-${i}`,
    type: "PAYMENT",
    amount: p.amount,
    paymentId: p.id,
  }));
  const allocs: Record<string, unknown>[] = [];
  for (const p of opts.confirmed) {
    const allocatable = p.amount - (p.credit ?? 0);
    if (p.inst) {
      allocs.push({ id: `pa-seed-${p.id}`, paymentId: p.id, installmentId: p.inst, amount: allocatable });
    } else {
      // Waterfall the allocatable part across installments in order.
      let rest = allocatable;
      for (const inst of installments) {
        if (rest <= 0) break;
        const sched = opts.installments.find((s, idx) => `inst-${idx}` === inst.id)!;
        const already = allocs
          .filter((a) => (a as { installmentId: string }).installmentId === inst.id)
          .reduce((s, a) => s + ((a as { amount: number }).amount), 0);
        const room = sched.paid - already;
        if (room <= 0) continue;
        const take = Math.min(rest, room);
        allocs.push({ id: `pa-seed-${p.id}-${inst.id}`, paymentId: p.id, installmentId: inst.id, amount: take });
        rest -= take;
      }
    }
  }
  return { payments, installments, transactions: [transaction], receipts: [], ledger, allocs, audits: [], bookings: [], activities: [] };
}

function gatePending(state: MockState, id: string, amount: number, inst: string | null): void {
  state.payments.push({
    id,
    transactionId: "txn-1",
    status: "PENDING_VERIFICATION",
    amount,
    paymentDate: new Date("2026-03-01T00:00:00Z"),
    paymentMethod: "Bank Transfer",
    installmentId: inst,
  });
}

function gateAccounts(): Record<string, MockState> {
  return {
    // Outright single-installment account.
    outright: seedGateAccount({
      ref: "TXN-GATE-OUTRIGHT",
      total: 5_800_000,
      installments: [{ n: 0, type: "INITIAL", scheduled: 5_800_000, paid: 0, status: "DUE" }],
      confirmed: [],
    }),
    // Multi-installment split with headroom.
    split: seedGateAccount({
      ref: "TXN-GATE-SPLIT",
      total: 10_000_000,
      installments: [
        { n: 0, type: "INITIAL", scheduled: 5_000_000, paid: 3_000_000, status: "PARTIALLY_PAID" },
        { n: 1, type: "MONTHLY", scheduled: 2_000_000, paid: 0, status: "PENDING" },
        { n: 2, type: "MONTHLY", scheduled: 2_000_000, paid: 0, status: "PENDING" },
        { n: 3, type: "MONTHLY", scheduled: 1_000_000, paid: 0, status: "PENDING" },
      ],
      confirmed: [{ id: "c1", amount: 3_000_000, inst: "inst-0" }],
    }),
    // Near-full account.
    nearfull: seedGateAccount({
      ref: "TXN-GATE-NEARFULL",
      total: 7_875_000,
      installments: [
        { n: 0, type: "INITIAL", scheduled: 3_937_500, paid: 3_937_500, status: "PAID" },
        { n: 1, type: "MONTHLY", scheduled: 656_250, paid: 656_250, status: "PAID" },
        { n: 2, type: "MONTHLY", scheduled: 656_250, paid: 0, status: "PENDING" },
        { n: 3, type: "MONTHLY", scheduled: 656_250, paid: 0, status: "PENDING" },
        { n: 4, type: "MONTHLY", scheduled: 656_250, paid: 0, status: "PENDING" },
        { n: 5, type: "MONTHLY", scheduled: 656_250, paid: 0, status: "PENDING" },
        { n: 6, type: "MONTHLY", scheduled: 656_250, paid: 0, status: "PENDING" },
      ],
      confirmed: [
        { id: "c1", amount: 3_937_500, inst: "inst-0" },
        { id: "c2", amount: 656_250, inst: "inst-1" },
      ],
    }),
    // Sandra-shaped: fully paid, prior credit parking, CANCELLED correction
    // history, forced PAID labels on underpaid rows. Same gate, no exceptions.
    sandra: seedGateAccount({
      ref: "TXN-GATE-SANDRA",
      total: 5_625_000,
      installments: [
        { n: 0, type: "INITIAL", scheduled: 2_812_500, paid: 1_813_000, status: "PAID" },
        { n: 1, type: "MONTHLY", scheduled: 937_500, paid: 937_500, status: "PAID" },
        { n: 2, type: "MONTHLY", scheduled: 937_500, paid: 62_500, status: "PAID" },
        { n: 3, type: "MONTHLY", scheduled: 937_500, paid: 937_500, status: "PAID" },
      ],
      confirmed: [
        { id: "p1", amount: 813_000, inst: null },
        { id: "p2", amount: 1_000_000, inst: null },
        { id: "p4", amount: 2_812_000, inst: null, isCredit: true, credit: 1_874_500 },
        { id: "p5", amount: 1_000_000, inst: null },
      ],
      cancelled: [
        { id: "x1", amount: 2_812_000 },
        { id: "x2", amount: 1_000_000 },
        { id: "x3", amount: 281_200 },
      ],
    }),
  };
}

// Ledger/schedule reconciliation invariants for one mock state.
function expectGateStateReconciles(state: MockState): void {
  const txn = state.transactions[0];
  const confirmed = state.payments.filter((p) => p.status === "CONFIRMED");
  const confirmedSum = confirmed.reduce((s, p) => s + p.amount, 0);
  expect(txn.totalPaid).toBe(confirmedSum);
  expect(txn.outstandingBalance).toBe(txn.totalPayable - confirmedSum);
  const schedSum = state.installments.reduce((s, i) => s + i.scheduledAmount, 0);
  expect(schedSum).toBe(txn.totalPayable);
  const entries = state.ledger.filter((e) => (e as { type: string }).type === "PAYMENT");
  expect(entries).toHaveLength(confirmed.length);
  for (const p of confirmed) {
    const entry = entries.find((e) => (e as { paymentId: string }).paymentId === p.id);
    expect(entry).toBeDefined();
    expect((entry as { amount: number }).amount).toBe(p.amount);
    const allocSum = state.allocs
      .filter((a) => (a as { paymentId: string }).paymentId === p.id)
      .reduce((s, a) => s + ((a as { amount: number }).amount), 0);
    expect(allocSum + (p.creditAmount ?? 0)).toBe(p.amount);
  }
  for (const inst of state.installments) {
    const allocSum = state.allocs
      .filter((a) => (a as { installmentId: string }).installmentId === inst.id)
      .reduce((s, a) => s + ((a as { amount: number }).amount), 0);
    expect(allocSum).toBe(inst.paidAmount);
  }
}

describe("total-balance gate (parametrized across accounts)", () => {
  it("seeded accounts reconcile before any new payment", () => {
    for (const state of Object.values(gateAccounts())) expectGateStateReconciles(state);
  });

  it("payment smaller than the installment amount is accepted", async () => {
    for (const key of ["outright", "split", "nearfull"] as const) {
      const state = gateAccounts()[key];
      gatePending(state, "new-1", 100_000, null);
      const result = await applyConfirmationDbUnit(makeMockTx(state), {
        paymentId: "new-1",
        transactionId: "txn-1",
        ...REF_BASE,
      });
      expect(result.newOutstanding).toBe(state.transactions[0].totalPayable - result.newTotalPaid);
      expectGateStateReconciles(state);
    }
  });

  it("payment larger than the installment amount but within balance is accepted", async () => {
    const cases: { key: "split" | "nearfull"; amount: number }[] = [
      { key: "split", amount: 6_000_000 },
      { key: "nearfull", amount: 1_000_000 },
    ];
    for (const { key, amount } of cases) {
      const state = gateAccounts()[key];
      gatePending(state, "new-1", amount, null);
      const result = await applyConfirmationDbUnit(makeMockTx(state), {
        paymentId: "new-1",
        transactionId: "txn-1",
        ...REF_BASE,
      });
      expect(result.newOutstanding).toBeGreaterThanOrEqual(0);
      expectGateStateReconciles(state);
    }
  });

  it("a payment aimed at a later installment still fills the earliest open one (never skips ahead)", async () => {
    // Split: the pointer says #2, but #0 is still open — money fills #0 first.
    const split = gateAccounts().split;
    gatePending(split, "new-1", 2_000_000, "inst-2");
    const r1 = await applyConfirmationDbUnit(makeMockTx(split), {
      paymentId: "new-1",
      transactionId: "txn-1",
      ...REF_BASE,
    });
    expect(r1.newTotalPaid).toBe(5_000_000);
    expect(split.installments[0].paidAmount).toBe(5_000_000);
    expect(split.installments[0].status).toBe("PAID");
    expect(split.installments[1].paidAmount).toBe(0);
    expect(split.installments[2].paidAmount).toBe(0);
    expectGateStateReconciles(split);

    // Near-full: the pointer says #3, but #2 is the earliest open one.
    const near = gateAccounts().nearfull;
    gatePending(near, "new-1", 656_250, "inst-3");
    await applyConfirmationDbUnit(makeMockTx(near), {
      paymentId: "new-1",
      transactionId: "txn-1",
      ...REF_BASE,
    });
    expect(near.installments[2].paidAmount).toBe(656_250);
    expect(near.installments[2].status).toBe("PAID");
    expect(near.installments[3].paidAmount).toBe(0);
    expectGateStateReconciles(near);
  });

  it("payment bringing the cumulative total exactly to the balance is accepted", async () => {
    const amounts: Record<string, number> = {
      outright: 5_800_000,
      split: 7_000_000,
      nearfull: 3_281_250,
    };
    for (const [key, amount] of Object.entries(amounts)) {
      const state = gateAccounts()[key];
      gatePending(state, "new-1", amount, null);
      const result = await applyConfirmationDbUnit(makeMockTx(state), {
        paymentId: "new-1",
        transactionId: "txn-1",
        ...REF_BASE,
      });
      expect(result.newOutstanding).toBe(0);
      expect(result.isPaidInFull).toBe(true);
      expectGateStateReconciles(state);
    }
  });

  it("payment pushing the cumulative total above the balance is rejected, ledger unchanged", async () => {
    const amounts: Record<string, number> = {
      outright: 5_800_001,
      split: 7_000_001,
      nearfull: 3_281_251,
      sandra: 1,
    };
    for (const [key, amount] of Object.entries(amounts)) {
      const state = gateAccounts()[key];
      const before = {
        ledger: state.ledger.length,
        receipts: state.receipts.length,
        totalPaid: state.transactions[0].totalPaid,
        paid: state.installments.map((i) => i.paidAmount),
      };
      gatePending(state, "new-1", amount, null);
      await expect(
        applyConfirmationDbUnit(makeMockTx(state), {
          paymentId: "new-1",
          transactionId: "txn-1",
          ...REF_BASE,
        })
      ).rejects.toBeInstanceOf(TotalBalanceExceededError);
      expect(state.ledger).toHaveLength(before.ledger);
      expect(state.receipts).toHaveLength(before.receipts);
      expect(state.transactions[0].totalPaid).toBe(before.totalPaid);
      expect(state.installments.map((i) => i.paidAmount)).toEqual(before.paid);
    }
  });

  it("sequential confirms where each fits alone but together exceed: only the first is accepted", async () => {
    for (const key of ["outright", "split"] as const) {
      const state = gateAccounts()[key];
      const first = key === "outright" ? 3_000_000 : 5_000_000;
      const second = key === "outright" ? 3_000_000 : 5_000_000;
      gatePending(state, "race-1", first, null);
      gatePending(state, "race-2", second, null);
      const tx = makeMockTx(state);
      // Serializes on the transaction row lock in production; the mock runs
      // the same order explicitly: second sees the first's committed total.
      await applyConfirmationDbUnit(tx, { paymentId: "race-1", transactionId: "txn-1", ...REF_BASE });
      await expect(
        applyConfirmationDbUnit(tx, { paymentId: "race-2", transactionId: "txn-1", ...REF_BASE })
      ).rejects.toBeInstanceOf(TotalBalanceExceededError);
      // Winner has its entry; loser wrote nothing (its claim flip persists
      // only because the mock has no rollback — production rolls it back).
      const entries = state.ledger.filter((e) => (e as { type: string }).type === "PAYMENT");
      expect(entries.some((e) => (e as { paymentId: string }).paymentId === "race-1")).toBe(true);
      expect(entries.some((e) => (e as { paymentId: string }).paymentId === "race-2")).toBe(false);
      expect(state.receipts.some((r) => (r as { paymentId: string }).paymentId === "race-2")).toBe(false);
    }
  });

  it("sandra-shaped account rejects exactly like any other account (no special handling)", async () => {
    const state = gateAccounts().sandra;
    gatePending(state, "new-1", 500_000, null);
    await expect(
      applyConfirmationDbUnit(makeMockTx(state), {
        paymentId: "new-1",
        transactionId: "txn-1",
        ...REF_BASE,
      })
    ).rejects.toBeInstanceOf(TotalBalanceExceededError);
    // Pre-existing history untouched: credit flag, CANCELLED rows, labels.
    expect(state.payments.find((p) => p.id === "p4")).toMatchObject({ isCredit: true, creditAmount: 1_874_500 });
    expect(state.payments.filter((p) => p.status === "CANCELLED")).toHaveLength(3);
    expect(state.ledger.filter((e) => (e as { type: string }).type === "PAYMENT")).toHaveLength(4);
  });
});

describe("toUserFacingError", () => {
  it("maps the expired-transaction Prisma error to a friendly message with no internals", () => {
    const raw = new Error(
      "Transaction API error: A query cannot be executed on an expired transaction. The timeout for this transaction was 5000 ms, however 5590 ms passed..."
    );
    const msg = toUserFacingError(raw, "confirm");
    expect(msg).toBe("Couldn't confirm payment. Please try again.");
    expect(msg).not.toContain("Prisma");
    expect(msg).not.toContain("5000");
  });

  it("maps domain errors to actionable messages", () => {
    expect(toUserFacingError(new PaymentAlreadyHandledError("x"), "confirm")).toContain("already confirmed or voided");
    expect(toUserFacingError(new OverScheduleError(2_900_000, 2_900_000, 2_900_000), "confirm")).toContain(
      "scheduled amount"
    );
    const overMsg = toUserFacingError(new TotalBalanceExceededError(2_000_000, 1_500_000, 2_900_000), "confirm");
    expect(overMsg).toContain("outstanding balance");
    expect(overMsg).not.toContain("TotalBalanceExceededError");
    expect(toUserFacingError({ code: "P2002" }, "record")).toContain("already recorded");
  });

  it("says nothing was changed when a transient failure rolled the transaction back", () => {
    const expired = toUserFacingError({ code: "P2028" }, "save");
    expect(expired).toBe("The database took too long, so nothing was changed. Please try again.");

    const unreachable = toUserFacingError({ code: "P1001" }, "save");
    expect(unreachable).toBe("The database was unreachable, so nothing was changed. Please try again.");
    expect(toUserFacingError({ code: "P1017" }, "save")).toBe(unreachable);
    expect(toUserFacingError({ code: "P1002" }, "save")).toBe(unreachable);
  });

  it("classifies only the retryable Prisma codes as transient", () => {
    // These rolled back, so the same unit of work may be attempted again.
    for (const code of ["P2028", "P2034", "P1001", "P1002", "P1017"]) {
      expect(isTransientDbError({ code })).toBe(true);
    }
    // A rejection of the request itself, or a code with no evidence of a
    // rollback, must not be retried.
    expect(isTransientDbError({ code: "P2002" })).toBe(false);
    expect(isTransientDbError({ code: "P2025" })).toBe(false);
    expect(isTransientDbError(new PaymentAlreadyHandledError("x"))).toBe(false);
    expect(isTransientDbError(new Error("socket closed"))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
    expect(isTransientDbError("P2028")).toBe(false);
  });

  it("keeps the retryable message distinct from the generic one", () => {
    // "Try again" alone cannot tell an admin a safe retry from a double post.
    expect(toUserFacingError({ code: "P2028" }, "save")).not.toBe(toUserFacingError(new Error("boom"), "save"));
  });
});
