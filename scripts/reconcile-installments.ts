// Reports (and optionally fixes) drift between Installment.paidAmount/status
// and the CONFIRMED-payment truth. The confirm/void transactions maintain the
// stored columns; this script catches anything that slipped through.
//
// Usage: npx tsx scripts/reconcile-installments.ts [--apply] [--include-test]
// Default is --dry-run: prints every drifted installment. --apply writes the
// recomputed paidAmount + derived status. Test fixtures are skipped unless
// --include-test is passed.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { deriveInstallmentStatus } from "../src/lib/paymentConfirmation.js";
import { replayAllocation, type AllocationInstallment } from "../src/lib/finance/allocations.js";

const APPLY = process.argv.includes("--apply");
const INCLUDE_TEST = process.argv.includes("--include-test");
// Prisma where-input compatible in both branches.
const relFilter: { transaction?: { isTest: boolean } } = INCLUDE_TEST ? {} : { transaction: { isTest: false } };
const directFilter: { isTest?: boolean } = INCLUDE_TEST ? {} : { isTest: false };

async function main() {
  const installments = await prisma.installment.findMany({
    where: { ...relFilter },
    select: { id: true, installmentNumber: true, type: true, scheduledAmount: true, paidAmount: true, status: true, dueDate: true, transactionId: true, transaction: { select: { ref: true } } },
    orderBy: { dueDate: "asc" },
  });
  const confirmed = await prisma.payment.findMany({
    where: { status: "CONFIRMED", ...relFilter },
    select: { id: true, amount: true, paymentDate: true, status: true, transactionId: true },
  });
  // Per-installment truth is the waterfall replay of each transaction's
  // confirmed payments — the same rule the finance service reads — so stored
  // paidAmount/status can never drift from what every screen shows.
  const instByTxn = new Map<string, AllocationInstallment[]>();
  for (const i of installments) {
    const list = instByTxn.get(i.transactionId) ?? [];
    list.push({ id: i.id, installmentNumber: i.installmentNumber, type: i.type, dueDate: i.dueDate, scheduledAmount: i.scheduledAmount });
    instByTxn.set(i.transactionId, list);
  }
  const payByTxn = new Map<string, typeof confirmed>();
  for (const p of confirmed) {
    const list = payByTxn.get(p.transactionId) ?? [];
    list.push(p);
    payByTxn.set(p.transactionId, list);
  }
  const paidByInst = new Map<string, number>();
  for (const [txnId, insts] of instByTxn) {
    const { installments: allocated } = replayAllocation(insts, payByTxn.get(txnId) ?? []);
    for (const a of allocated) paidByInst.set(a.id, a.confirmedPaid);
  }
  const now = new Date();
  let drift = 0;
  for (const i of installments) {
    const truth = paidByInst.get(i.id) ?? 0;
    const truthStatus = deriveInstallmentStatus(truth, i.scheduledAmount, i.dueDate, now);
    if (truth !== i.paidAmount || truthStatus !== i.status) {
      drift++;
      console.log(
        `  DRIFT ${i.transaction.ref} #${i.installmentNumber}: stored paid=${i.paidAmount} status=${i.status} → truth paid=${truth} status=${truthStatus}`
      );
      if (APPLY) {
        await prisma.installment.update({
          where: { id: i.id },
          data: { paidAmount: truth, status: truthStatus as never, updatedAt: now },
        });
      }
    }
  }
  // Transaction totals: recomputed from CONFIRMED payments.
  const txns = await prisma.transaction.findMany({
    where: { ...directFilter },
    select: { id: true, ref: true, totalPayable: true, totalPaid: true, outstandingBalance: true, status: true },
  });
  const paidByTxn = new Map<string, number>();
  const allConfirmed = await prisma.payment.findMany({
    where: { status: "CONFIRMED", ...relFilter },
    select: { amount: true, transactionId: true },
  });
  for (const p of allConfirmed) paidByTxn.set(p.transactionId, (paidByTxn.get(p.transactionId) ?? 0) + p.amount);
  for (const t of txns) {
    const truth = paidByTxn.get(t.id) ?? 0;
    const truthOut = t.totalPayable - truth;
    if (truth !== t.totalPaid || truthOut !== t.outstandingBalance) {
      drift++;
      console.log(`  DRIFT ${t.ref}: stored paid=${t.totalPaid} out=${t.outstandingBalance} → truth paid=${truth} out=${truthOut}`);
      if (APPLY) {
        await prisma.transaction.update({
          where: { id: t.id },
          data: {
            totalPaid: truth,
            outstandingBalance: truthOut,
            status: truthOut <= 0 ? "PAID_IN_FULL" : t.status === "PAID_IN_FULL" ? "ACTIVE" : t.status,
            updatedAt: now,
          },
        });
      }
    }
  }
  console.log(`[dry-run=${!APPLY}] checked ${installments.length} installments + ${txns.length} transactions, ${drift} drifted.`);
  if (!APPLY) console.log("Dry run complete — re-run with --apply to fix.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
