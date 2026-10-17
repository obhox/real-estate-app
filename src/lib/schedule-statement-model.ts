// DB -> schedule-statement model. The ONE place the client schedule document
// reads the database. Per-installment money comes from the shared replay
// (schedule-statement.ts -> finance/allocations.ts), never a stored total, so
// this document can never disagree with the payment schedule or receipts.
//
// Like the ledger statement model, header fields (company/client/property) and
// the account reference are read here once; internal guards live alongside but
// are never printed on the issued document.

import { formatDateDMY } from "@/lib/time";
import { formatDisplayName } from "@/lib/formatName";
import { COMPANY } from "@/lib/documents/brand";
import type { TxClient } from "@/lib/finance/ledger";
import {
  buildScheduleStatement,
  SCHEDULE_LAYOUT_VERSION,
  type ScheduleStatement,
} from "@/lib/schedule-statement";
import type { AllocationInstallment, AllocationPayment } from "@/lib/finance/allocations";

export type ScheduleStatementModel = ScheduleStatement & {
  isDraft: boolean;
  number?: string;
  accountRef: string;
  generatedOn: string;
  asOf: string;
  company: { name: string; addressLine: string; website: string; email: string; phone: string };
  client: { name: string; phone?: string; email?: string };
  property: { estate: string; unitType: string; sku: string; plots: number };
  // Internal only — never rendered on the client document.
  dataCheckErrors: string[];
};

export type ScheduleStatementModelDb = TxClient & {
  transaction: {
    findUnique(args: unknown): Promise<{
      id: string;
      ref: string;
      customerName: string;
      customerEmail: string;
      customerPhone: string | null;
      estate: string;
      unitType: string | null;
      plotCode: string | null;
      plotQuantity: number;
      totalPayable: number;
    } | null>;
  };
  installment: {
    findMany(args: unknown): Promise<
      { id: string; installmentNumber: number; type: string; dueDate: Date; scheduledAmount: number }[]
    >;
  };
  payment: {
    findMany(args: unknown): Promise<
      { id: string; amount: number; status: string; paymentDate: Date }[]
    >;
  };
};

export async function buildScheduleStatementModel(
  db: ScheduleStatementModelDb,
  opts: { transactionId: string; asOf?: Date; draft: boolean; number?: string }
): Promise<ScheduleStatementModel> {
  const now = new Date();
  const asOfDate = opts.asOf ?? now;
  const txn = await db.transaction.findUnique({ where: { id: opts.transactionId } });
  if (!txn) throw new Error("Transaction not found");

  const [installments, payments] = await Promise.all([
    db.installment.findMany({
      where: { transactionId: opts.transactionId },
      orderBy: { installmentNumber: "asc" },
      select: { id: true, installmentNumber: true, type: true, dueDate: true, scheduledAmount: true },
    }),
    db.payment.findMany({
      where: { transactionId: opts.transactionId },
      select: { id: true, amount: true, status: true, paymentDate: true },
    }),
  ]);

  const inst: AllocationInstallment[] = installments.map((i) => ({
    id: i.id,
    installmentNumber: i.installmentNumber,
    type: i.type,
    dueDate: new Date(i.dueDate),
    scheduledAmount: i.scheduledAmount,
  }));
  const pay: AllocationPayment[] = payments.map((p) => ({
    id: p.id,
    amount: p.amount,
    status: p.status,
    paymentDate: new Date(p.paymentDate),
  }));

  const built = buildScheduleStatement({ installments: inst, payments: pay, now: asOfDate });

  const scheduledTotal = inst.reduce((s, i) => s + i.scheduledAmount, 0);
  const dataCheckErrors: string[] = [];
  if (inst.length === 0) {
    dataCheckErrors.push("This transaction has no payment plan (no installments).");
  }
  if (inst.length > 0 && scheduledTotal !== txn.totalPayable) {
    dataCheckErrors.push(
      `Scheduled installments total ${scheduledTotal} but the transaction total payable is ${txn.totalPayable}.`
    );
  }

  return {
    ...built,
    isDraft: opts.draft,
    ...(opts.draft ? {} : { number: opts.number }),
    accountRef: txn.ref,
    generatedOn: formatDateDMY(now),
    asOf: formatDateDMY(asOfDate),
    company: {
      name: COMPANY.name,
      addressLine: COMPANY.address,
      website: COMPANY.website,
      email: COMPANY.email,
      phone: COMPANY.phone,
    },
    client: {
      name: formatDisplayName(txn.customerName),
      ...(txn.customerPhone ? { phone: txn.customerPhone } : {}),
      ...(txn.customerEmail ? { email: txn.customerEmail } : {}),
    },
    property: {
      estate: txn.estate,
      unitType: txn.unitType ?? "",
      sku: txn.plotCode ?? "",
      plots: txn.plotQuantity,
    },
    layoutVersion: SCHEDULE_LAYOUT_VERSION,
    dataCheckErrors,
  };
}
