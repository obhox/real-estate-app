import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";

// Remove named people's records from bookings, transactions, payments,
// receipts and inspections. Defaults to --dry-run: prints exactly what it
// would delete and changes nothing. Pass --apply to execute.
//
// DB work runs inside one prisma.$transaction (rule 2); the on-disk receipt
// PDFs are removed only after the commit.

const NAMES = [
  "daniel solomon",
  "toochukwu",
  "tochukwu",
  "samuel charlse chukwuebuka",
  "divine samuel",
];

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const INCLUDE_CUSTOMERS = args.has("--include-customers");
const INCLUDE_AUDIT = args.has("--include-audit");

const naira = (n: number) => `₦${Number(n).toLocaleString("en-NG")}`;

async function main() {
  console.log(APPLY ? "MODE: APPLY (will delete)" : "MODE: DRY-RUN (no changes)");
  console.log(`Matching names: ${NAMES.join(", ")}\n`);

  const bookings = await prisma.inspectionBooking.findMany({
    where: { OR: NAMES.map((n) => ({ name: { contains: n, mode: "insensitive" as const } })) },
    select: { id: true, ref: true, name: true, email: true, status: true, createdAt: true },
  });
  const transactions = await prisma.transaction.findMany({
    where: { OR: NAMES.map((n) => ({ customerName: { contains: n, mode: "insensitive" as const } })) },
    select: {
      id: true, ref: true, customerName: true, status: true, totalPayable: true,
      totalPaid: true, outstandingBalance: true, isTest: true, bookingId: true,
    },
  });
  const txnIds = transactions.map((t) => t.id);
  const payments = await prisma.payment.findMany({
    where: { transactionId: { in: txnIds } },
    select: { id: true, paymentReference: true, amount: true, status: true, paymentDate: true, transactionId: true },
  });
  const paymentIds = payments.map((p) => p.id);
  const receipts = await prisma.receipt.findMany({
    where: {
      OR: [
        { customerName: { contains: NAMES[0], mode: "insensitive" as const } },
        ...NAMES.slice(1).map((n) => ({ customerName: { contains: n, mode: "insensitive" as const } })),
        { transactionId: { in: txnIds } },
        { paymentId: { in: paymentIds } },
      ],
    },
    select: { id: true, ref: true, customerName: true, finalAmount: true, transactionId: true, paymentId: true, voidedAt: true, pdfPath: true },
  });
  const customers = await prisma.customer.findMany({
    where: { OR: NAMES.map((n) => ({ name: { contains: n, mode: "insensitive" as const } })) },
    select: { id: true, name: true, email: true, isTest: true },
  });

  // Everything that cascades from the entities above (reported for transparency).
  const counts = {
    installments: await prisma.installment.count({ where: { transactionId: { in: txnIds } } }),
    payments: payments.length,
    allocations: await prisma.paymentAllocation.count({ where: { paymentId: { in: paymentIds } } }),
    ledgerEntries: await prisma.ledgerEntry.count({ where: { transactionId: { in: txnIds } } }),
    statements: await prisma.statement.count({ where: { transactionId: { in: txnIds } } }),
    bookingMessages: await prisma.bookingMessage.count({ where: { bookingId: { in: bookings.map((b) => b.id) } } }),
    bookingActivity: await prisma.bookingActivity.count({ where: { bookingId: { in: bookings.map((b) => b.id) } } }),
    internalNotes: await prisma.internalNote.count({ where: { bookingId: { in: bookings.map((b) => b.id) } } }),
  };
  const entityIds = [...bookings.map((b) => b.id), ...txnIds, ...paymentIds, ...receipts.map((r) => r.id)];
  const audits = await prisma.auditEvent.count({ where: { entityId: { in: entityIds } } });

  console.log(`Inspections/bookings: ${bookings.length}`);
  for (const b of bookings) console.log(`  ${b.ref}  ${b.name}  <${b.email}>  ${b.status}  ${b.createdAt.toISOString().slice(0, 10)}`);
  console.log(`\nTransactions: ${transactions.length}`);
  for (const t of transactions) {
    console.log(`  ${t.ref}  ${t.customerName}  ${t.status}${t.isTest ? " [TEST]" : ""}  payable=${naira(Number(t.totalPayable))} paid=${naira(Number(t.totalPaid))} out=${naira(Number(t.outstandingBalance))}`);
  }
  console.log(`\nPayments: ${payments.length}`);
  for (const p of payments) console.log(`  ${p.paymentReference}  ${p.status.padEnd(12)} ${naira(Number(p.amount)).padStart(14)}  ${p.paymentDate.toISOString().slice(0, 10)}`);
  console.log(`\nReceipts: ${receipts.length}`);
  for (const r of receipts) console.log(`  ${r.ref}  ${r.customerName}  ${naira(Number(r.finalAmount))}${r.voidedAt ? " VOID" : ""}${r.pdfPath ? `  pdf=${r.pdfPath}` : ""}`);
  console.log(`\nCustomers matching: ${customers.length}`);
  for (const c of customers) console.log(`  ${c.name}  <${c.email}>${c.isTest ? " [TEST]" : ""}`);

  console.log(`\nWill be deleted with the above:`);
  console.log(`  installments=${counts.installments} payments=${counts.payments} allocations=${counts.allocations} ledgerEntries=${counts.ledgerEntries} statements=${counts.statements}`);
  console.log(`  bookingMessages=${counts.bookingMessages} bookingActivity=${counts.bookingActivity} internalNotes=${counts.internalNotes}`);
  console.log(`\nAuditEvent rows referencing these ids: ${audits} (left in place unless --include-audit)`);
  console.log(`Customers: ${INCLUDE_CUSTOMERS ? "will be deleted" : "left in place unless --include-customers"}`);

  if (!APPLY) {
    console.log("\nDRY-RUN complete. Re-run with --apply to delete.");
    await prisma.$disconnect();
    return;
  }

  const pdfPaths = receipts.map((r) => r.pdfPath).filter((p): p is string => !!p);

  await prisma.$transaction(async (tx) => {
    await tx.receipt.deleteMany({ where: { id: { in: receipts.map((r) => r.id) } } });
    // Allocations reference installments Restrict, so clear them before the
    // transaction cascade reaches the installments.
    await tx.paymentAllocation.deleteMany({ where: { paymentId: { in: paymentIds } } });
    await tx.transaction.deleteMany({ where: { id: { in: txnIds } } });
    // BookingActivity carries no cascade (Prisma default Restrict) — clear it
    // first so the booking rows can go.
    await tx.bookingActivity.deleteMany({ where: { bookingId: { in: bookings.map((b) => b.id) } } });
    await tx.inspectionBooking.deleteMany({ where: { id: { in: bookings.map((b) => b.id) } } });
    if (INCLUDE_CUSTOMERS) await tx.customer.deleteMany({ where: { id: { in: customers.map((c) => c.id) } } });
    if (INCLUDE_AUDIT) await tx.auditEvent.deleteMany({ where: { entityId: { in: entityIds } } });
  });

  let removedFiles = 0;
  for (const rel of pdfPaths) {
    const abs = path.isAbsolute(rel) ? rel : path.join(process.cwd(), "public", rel.replace(/^\/?public\//, ""));
    try { await fs.unlink(abs); removedFiles++; } catch { /* already gone */ }
  }

  console.log(`\nAPPLIED. Deleted ${receipts.length} receipts, ${transactions.length} transactions, ${bookings.length} bookings${INCLUDE_CUSTOMERS ? `, ${customers.length} customers` : ""}${INCLUDE_AUDIT ? `, ${audits} audits` : ""}. Removed ${removedFiles}/${pdfPaths.length} receipt PDF files.`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
