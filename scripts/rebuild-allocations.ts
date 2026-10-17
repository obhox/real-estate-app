// Rebuilds PaymentAllocation rows from the CONFIRMED-payment waterfall (the
// single written copy of allocation) and re-syncs the stored money columns it
// derives. Idempotent: the recompute deletes and recreates each payment's
// allocations from the same confirmed history, so a second run reports no
// change. This is the Stage 6 backfill for rows created before allocations
// existed.
//
// Usage: npx tsx scripts/rebuild-allocations.ts [--apply] [--include-test] [--txn <ref>]
// Default is --dry-run: prints every allocation it would add/remove per
// payment, every installment whose paid amount would change, and the payment
// references that look wrong. --apply writes inside one DB transaction per
// transaction row and then verifies the invariants. Test fixtures are skipped
// unless --include-test is passed.
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { deriveInstallmentStatus } from "../src/lib/paymentConfirmation.js";
import { replayAllocationDetail, type AllocationInstallment } from "../src/lib/finance/allocations.js";
import { recomputeTransactionAllocations, assertTransactionInvariants, PaymentCorruptStateError } from "../src/lib/finance/ledger.js";

const APPLY = process.argv.includes("--apply");
const INCLUDE_TEST = process.argv.includes("--include-test");
const txnFlagIdx = process.argv.indexOf("--txn");
const ONLY_TXN = txnFlagIdx >= 0 ? process.argv[txnFlagIdx + 1] : null;
// Placeholder references operators typed to unblock a form; never a real bank ref.
const PLACEHOLDER_REFS = new Set(["12345678", "123456789", "00000000", "na", "n/a", "-"]);

type PaymentRow = { id: string; amount: number; paymentDate: Date; status: string; paymentReference: string | null };

function refFlags(payments: PaymentRow[]): string[] {
  const flags: string[] = [];
  const seen = new Map<string, number>();
  for (const p of payments) {
    const ref = (p.paymentReference ?? "").trim();
    if (!ref) flags.push(`payment ${p.id.slice(0, 8)}… (${p.amount}): no bank reference`);
    else if (PLACEHOLDER_REFS.has(ref.toLowerCase())) flags.push(`payment ${ref}: placeholder reference "${ref}"`);
    seen.set(ref, (seen.get(ref) ?? 0) + 1);
  }
  for (const [ref, n] of seen) {
    if (ref && n > 1) flags.push(`reference "${ref}" used by ${n} payments in this transaction`);
  }
  return flags;
}

async function main() {
  const txns = await prisma.transaction.findMany({
    where: ONLY_TXN ? { ref: ONLY_TXN } : {},
    select: { id: true, ref: true, totalPayable: true, totalPaid: true, outstandingBalance: true, isTest: true },
    orderBy: { ref: "asc" },
  });
  if (ONLY_TXN && txns.length === 0) {
    console.log(`No transaction with ref ${ONLY_TXN}.`);
    return;
  }

  let allocChanges = 0;
  let allocAdd = 0;
  let allocRemove = 0;
  let paidChanges = 0;
  let totalChanges = 0;
  let flagCount = 0;
  let applied = 0;
  let skipped = 0;
  let invariantViolations = 0;

  for (const t of txns) {
    if (!INCLUDE_TEST && t.isTest) {
      skipped++;
      continue;
    }
    const installments = await prisma.installment.findMany({
      where: { transactionId: t.id },
      orderBy: { installmentNumber: "asc" },
      select: { id: true, installmentNumber: true, type: true, dueDate: true, scheduledAmount: true, paidAmount: true, status: true },
    });
    const active = installments.filter((i) => i.status !== "WAIVED");
    const payments = await prisma.payment.findMany({
      where: { transactionId: t.id, status: "CONFIRMED" },
      select: { id: true, amount: true, paymentDate: true, status: true, paymentReference: true },
      orderBy: [{ paymentDate: "asc" }, { id: "asc" }],
    });

    // BEFORE: what is stored today.
    const stored = await prisma.paymentAllocation.findMany({
      where: { paymentId: { in: payments.map((p) => p.id) } },
      select: { paymentId: true, installmentId: true, amount: true },
    });
    const before = new Map<string, Map<string, number>>();
    for (const a of stored) {
      const m = before.get(a.paymentId) ?? new Map<string, number>();
      m.set(a.installmentId, (m.get(a.installmentId) ?? 0) + a.amount);
      before.set(a.paymentId, m);
    }
    const beforePaid = new Map(installments.map((i) => [i.id, i.paidAmount ?? 0]));

    // AFTER: replay of the confirmed waterfall (the truth).
    const detail = replayAllocationDetail(
      active.map(
        (i): AllocationInstallment => ({ id: i.id, installmentNumber: i.installmentNumber, type: i.type, dueDate: i.dueDate, scheduledAmount: i.scheduledAmount })
      ),
      payments.map((p) => ({ id: p.id, amount: p.amount, paymentDate: p.paymentDate, status: p.status }))
    );
    const afterByPayment = new Map<string, Map<string, number>>();
    for (const pr of detail.payments) {
      const m = new Map<string, number>();
      for (const a of pr.allocations) m.set(a.installmentId, (m.get(a.installmentId) ?? 0) + a.amount);
      afterByPayment.set(pr.paymentId, m);
    }
    const afterPaid = new Map(detail.installments.map((i) => [i.id, i.confirmedPaid]));
    const numById = new Map(installments.map((i) => [i.id, i.installmentNumber]));
    const label = (id: string) => `#${numById.get(id) ?? "?"}`;

    const lines: string[] = [];
    for (const p of payments) {
      const b = before.get(p.id) ?? new Map<string, number>();
      const a = afterByPayment.get(p.id) ?? new Map<string, number>();
      const ids = new Set([...b.keys(), ...a.keys()]);
      for (const instId of ids) {
        const from = b.get(instId) ?? 0;
        const to = a.get(instId) ?? 0;
        if (from !== to) {
          allocChanges++;
          if (from === 0) allocAdd++;
          else if (to === 0) allocRemove++;
          lines.push(`    payment ${p.paymentReference ?? p.id.slice(0, 8)} → ${label(instId)}: ${from} → ${to}`);
        }
      }
    }
    for (const i of active) {
      const from = beforePaid.get(i.id) ?? 0;
      const to = afterPaid.get(i.id) ?? 0;
      if (from !== to) {
        paidChanges++;
        lines.push(`    installment ${label(i.id)} paid: ${from} → ${to}`);
      }
    }
    const truthTotal = payments.reduce((s, p) => s + p.amount, 0);
    const truthOut = t.totalPayable - truthTotal;
    if (truthTotal !== t.totalPaid || truthOut !== t.outstandingBalance) {
      totalChanges++;
      lines.push(`    totals: paid ${t.totalPaid} → ${truthTotal}, outstanding ${t.outstandingBalance} → ${truthOut}`);
    }
    const flags = refFlags(payments);
    flagCount += flags.length;

    const changed = lines.length > 0;
    if (changed || flags.length > 0) {
      console.log(`${t.ref}${t.isTest ? " [TEST]" : ""}`);
      for (const l of lines) console.log(l);
      for (const f of flags) console.log(`    FLAG ${f}`);
    }

    if (!APPLY) {
      // Read-only: assertTransactionInvariants only reads, so in dry-run it
      // reports what is broken in the *stored* state right now — and after an
      // --apply re-run, 0 violations prove the rebuild left a consistent state.
      try {
        await assertTransactionInvariants(prisma as never, t.id, { expectedTotalPaid: truthTotal });
      } catch (e) {
        invariantViolations++;
        console.log(`    INVARIANT ${t.ref}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    if (APPLY && (changed || truthTotal !== t.totalPaid || truthOut !== t.outstandingBalance)) {
      try {
        await prisma.$transaction(
          async (tx) => {
            const res = await recomputeTransactionAllocations(tx, t.id, { deriveStatus: deriveInstallmentStatus });
            await assertTransactionInvariants(tx, t.id, { expectedTotalPaid: res.totalPaid });
            await tx.transaction.update({
              where: { id: t.id },
              data: {
                totalPaid: truthTotal,
                outstandingBalance: truthOut,
                status: truthOut <= 0 ? "PAID_IN_FULL" : t.totalPaid === t.totalPayable && truthOut > 0 ? "ACTIVE" : undefined,
                updatedAt: new Date(),
              },
            });
          },
          // The recompute is many round trips (delete + create per allocation +
          // an update per installment/payment); on a remote DB that exceeds the
          // 5s default. Same guard the confirm path uses, with more headroom.
          { maxWait: 10_000, timeout: 60_000 }
        );
        applied++;
      } catch (e) {
        const msg = e instanceof PaymentCorruptStateError ? e.message : e instanceof Error ? e.message : String(e);
        console.error(`    ERROR ${t.ref}: ${msg} — left unchanged.`);
      }
    }
  }

  console.log(
    `\n[dry-run=${!APPLY}] ${txns.length} transactions (${skipped} test skipped). ` +
      `Allocation rows changing: ${allocChanges} (${allocAdd} new, ${allocRemove} removed). ` +
      `Installments changing paid: ${paidChanges}. Transaction totals changing: ${totalChanges}. ` +
      `Reference flags: ${flagCount}. Invariant violations: ${invariantViolations}. Applied: ${applied}.`
  );
  if (!APPLY) console.log("Dry run complete — re-run with --apply to rebuild.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
