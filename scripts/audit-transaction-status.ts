// READ-ONLY audit: compares the CURRENT derived status/outstanding/next-due
// against the NEW totals-derived rules for every transaction, and flags the
// inconsistencies that motivated the change. Never writes, never migrates.
//
// New rules (money derived from confirmed payments only):
//   balance = totalPayable - totalPaid
//   balance <= 0            -> "Paid in full" (overdue 0, no next due, never red)
//   else overdue = max(0, sum(scheduled | due < today) - totalPaid)
//     overdue > 0          -> "Behind", days = days since the earliest
//                             installment not covered by cumulative totalPaid
//     overdue == 0         -> "On track", next due = first installment not
//                             covered by cumulative totalPaid
//
// Usage: [SHOW_TEST=1] npx tsx scripts/audit-transaction-status.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { replayAllocation } from "../src/lib/finance/allocations.js";
import { lagosDayKey, startOfTodayLagos } from "../src/lib/time.js";

const naira = (n: number) => `₦${n.toLocaleString("en-NG")}`;

function dayKeyDiff(fromKey: string, toKey: string): number {
  const [fy, fm, fd] = fromKey.split("-").map(Number);
  const [ty, tm, td] = toKey.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

type NewStatus = "Paid in full" | "Behind" | "On track";

type NewResult = {
  status: NewStatus;
  balance: number;
  overdueAmount: number;
  overdueDays: number | null;
  nextDue: { amount: number; dueDate: Date } | null;
  overpaid: number;
};

function deriveNew(
  totalPayable: number,
  installments: { installmentNumber: number; dueDate: Date; scheduledAmount: number; confirmedPaid: number }[],
  totalPaid: number,
  now: Date
): NewResult {
  const balance = totalPayable - totalPaid;
  const overpaid = balance < 0 ? -balance : 0;
  if (balance <= 0) {
    return { status: "Paid in full", balance, overdueAmount: 0, overdueDays: null, nextDue: null, overpaid };
  }
  const todayKey = lagosDayKey(now);
  const ordered = [...installments].sort((a, b) => a.installmentNumber - b.installmentNumber);

  // Cumulative paid covers scheduled installments in order; find the first one
  // the cumulative total does not fully cover.
  let carry = totalPaid;
  let firstUncoveredIdx = -1;
  let firstUncoveredRemaining = 0;
  for (let i = 0; i < ordered.length; i++) {
    const take = Math.min(carry, ordered[i].scheduledAmount);
    carry -= take;
    const remaining = ordered[i].scheduledAmount - take;
    if (remaining > 0) {
      firstUncoveredIdx = i;
      firstUncoveredRemaining = remaining;
      break;
    }
  }

  const pastDueScheduled = ordered
    .filter((i) => lagosDayKey(i.dueDate) < todayKey)
    .reduce((s, i) => s + i.scheduledAmount, 0);
  const overdueAmount = Math.max(0, pastDueScheduled - totalPaid);

  if (overdueAmount > 0) {
    const uncovered = firstUncoveredIdx >= 0 ? ordered[firstUncoveredIdx] : null;
    const days = uncovered
      ? Math.max(0, dayKeyDiff(lagosDayKey(uncovered.dueDate), todayKey))
      : null;
    return { status: "Behind", balance, overdueAmount, overdueDays: days, nextDue: null, overpaid };
  }

  const nextDue =
    firstUncoveredIdx >= 0
      ? { amount: firstUncoveredRemaining, dueDate: ordered[firstUncoveredIdx].dueDate }
      : null;
  return { status: "On track", balance, overdueAmount: 0, overdueDays: null, nextDue, overpaid };
}

async function main() {
  const showTest = process.env.SHOW_TEST === "1";
  const now = startOfTodayLagos();

  const txns = await prisma.transaction.findMany({
    where: showTest ? {} : { isTest: false },
    select: { id: true, ref: true, customerName: true, totalPayable: true, isTest: true },
    orderBy: { createdAt: "asc" },
  });

  const ids = txns.map((t) => t.id);
  const [installments, payments] = await Promise.all([
    prisma.installment.findMany({ where: { transactionId: { in: ids } }, orderBy: { installmentNumber: "asc" } }),
    prisma.payment.findMany({
      where: { transactionId: { in: ids }, status: "CONFIRMED" },
      select: { id: true, amount: true, paymentDate: true, transactionId: true, status: true, installmentId: true },
    }),
  ]);

  const instByTxn = new Map<string, typeof installments>();
  for (const i of installments) {
    const list = instByTxn.get(i.transactionId) ?? [];
    list.push(i);
    instByTxn.set(i.transactionId, list);
  }
  const payByTxn = new Map<string, typeof payments>();
  for (const p of payments) {
    const list = payByTxn.get(p.transactionId) ?? [];
    list.push(p);
    payByTxn.set(p.transactionId, list);
  }

  const flagged: string[] = [];
  const header = [
    "REF".padEnd(16),
    "CLIENT".padEnd(20),
    "CONTRACT".padStart(13),
    "PAID".padStart(13),
    "BALANCE".padStart(13),
    "NOW".padEnd(12),
    "NOW-OUT".padStart(13),
    "NOW-NEXT".padStart(24),
    "NEW".padEnd(12),
    "NEW-OD".padStart(13),
    "FLAGS",
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));

  for (const t of txns) {
    const insts = (instByTxn.get(t.id) ?? []).filter((i) => i.status !== "WAIVED");
    const pays = payByTxn.get(t.id) ?? [];
    const { installments: allocated, credit } = replayAllocation(
      insts.map((i) => ({
        id: i.id,
        installmentNumber: i.installmentNumber,
        type: i.type,
        dueDate: new Date(i.dueDate),
        scheduledAmount: i.scheduledAmount,
      })),
      pays.map((p) => ({ id: p.id, amount: p.amount, paymentDate: p.paymentDate, status: p.status }))
    );
    const totalPaid = allocated.reduce((s, a) => s + a.confirmedPaid, 0) + credit;
    const scheduledTotal = insts.reduce((s, i) => s + i.scheduledAmount, 0);

    // Current display (mirror of getTransactionFinancials, incl. carry-forward).
    const orderedNow = [...allocated].sort((a, b) => a.installmentNumber - b.installmentNumber);
    const todayKey = lagosDayKey(now);
    let carry = credit;
    let nowNext: { amount: number; dueDate: Date } | null = null;
    let nowOverdueCount = 0;
    for (const i of orderedNow) {
      const due = Math.max(0, i.scheduledAmount - i.confirmedPaid - carry);
      carry = Math.max(0, i.confirmedPaid + carry - i.scheduledAmount);
      if (due <= 0) continue;
      if (!nowNext) nowNext = { amount: due, dueDate: i.dueDate };
      if (lagosDayKey(i.dueDate) < todayKey) nowOverdueCount += 1;
    }
    const nowOutstanding = t.totalPayable - totalPaid;
    const nowIsFullyPaid = nowOutstanding <= 0 && !nowNext;
    const nowIsOverdue = nowOverdueCount > 0;
    const nowStatus = nowIsFullyPaid ? "Paid in full" : nowIsOverdue ? "Behind" : "On track";
    const nowDaysOverdue = nowNext ? Math.max(0, -dayKeyDiff(todayKey, lagosDayKey(nowNext.dueDate))) || null : null;

    const nu = deriveNew(
      t.totalPayable,
      allocated.map((a) => ({
        installmentNumber: a.installmentNumber,
        dueDate: a.dueDate,
        scheduledAmount: a.scheduledAmount,
        confirmedPaid: a.confirmedPaid,
      })),
      totalPaid,
      now
    );

    const flags: string[] = [];
    if (nowStatus !== nu.status) flags.push(`STATUS(${nowStatus}->${nu.status})`);
    if (nowOutstanding !== nu.balance) flags.push("BALANCE");
    if (nu.overpaid > 0) flags.push(`OVERPAID(${naira(nu.overpaid)})`);
    if (scheduledTotal !== t.totalPayable) {
      flags.push(`SCHEDULE!=${
        scheduledTotal > t.totalPayable ? "+" : "-"
      }${naira(Math.abs(scheduledTotal - t.totalPayable))}`);
    }
    const nowNextKey = nowNext ? `${nowNext.amount}|${lagosDayKey(nowNext.dueDate)}` : "-";
    const newNextKey = nu.nextDue ? `${nu.nextDue.amount}|${lagosDayKey(nu.nextDue.dueDate)}` : "-";
    if (nowNextKey !== newNextKey) flags.push("NEXT");
    const nowOverdueShown = nowIsOverdue ? nowDaysOverdue : null;
    if (nowOverdueShown !== nu.overdueDays) flags.push("OD-DAYS");

    const nowNextTxt = nowNext
      ? `${naira(nowNext.amount)} ${lagosDayKey(nowNext.dueDate)}${nowIsOverdue && nowDaysOverdue ? ` (${nowDaysOverdue}d late)` : ""}`
      : "-";
    const newOdTxt = nu.status === "Behind" ? `${naira(nu.overdueAmount)} ${nu.overdueDays}d` : "-";

    if (flags.length > 0) flagged.push(`${t.ref}: ${flags.join(", ")}`);

    console.log(
      [
        t.ref.padEnd(16),
        t.customerName.slice(0, 20).padEnd(20),
        naira(t.totalPayable).padStart(13),
        naira(totalPaid).padStart(13),
        naira(nu.balance).padStart(13),
        nowStatus.padEnd(12),
        naira(nowOutstanding).padStart(13),
        nowNextTxt.padStart(24),
        nu.status.padEnd(12),
        newOdTxt.padStart(13),
        flags.join(" "),
      ].join(" ")
    );
  }

  console.log("");
  console.log(`Transactions audited: ${txns.length}${showTest ? "" : " (non-test)"}`);
  console.log(`Flagged: ${flagged.length}`);
  for (const f of flagged) console.log(`  - ${f}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
