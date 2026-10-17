import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@/generated/prisma/client";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { generateUniquePaymentRef } from "@/lib/ref";
import { lagosDayKey, toDateOnlyNoonUtc } from "@/lib/time";
import { validatePayment } from "@/lib/paymentValidation";
import { getTransactionSummary } from "@/lib/finance";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // Free amount: the schedule is a guide, never a gate. No installment picker
  // — confirmation waterfalls from the oldest unpaid installment, and any
  // amount above the outstanding balance auto-parks as visible credit.
  const { amount, paymentDate, paymentMethod, bankReference, notes, idempotencyKey, allocationReviewed } = body;
  const amt = Number(amount);

  // Effective dates are calendar dates: normalize to noon UTC (stable under
  // DATE and timestamp columns in every zone) via the shared helper.
  let date: Date;
  try {
    date = paymentDate ? toDateOnlyNoonUtc(String(paymentDate)) : toDateOnlyNoonUtc(new Date());
  } catch {
    return NextResponse.json({ error: "Invalid payment date" }, { status: 400 });
  }

  // Enforced idempotency: one UUID per form open. A repeat submission with the
  // same key returns the existing row (unique constraint is the enforcer;
  // the lookup below is the fast path). Retires the old 60-second window.
  const key = typeof idempotencyKey === "string" && idempotencyKey.length >= 8 ? idempotencyKey.slice(0, 120) : null;
  if (!key) return NextResponse.json({ error: "idempotencyKey is required (one UUID per form open)" }, { status: 400 });

  // Create payment as PENDING_VERIFICATION — does NOT affect totals until confirmed
  try {
    const transaction = await prisma.transaction.findUnique({ where: { id } });
    if (!transaction) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    if (transaction.status === "CANCELLED") return NextResponse.json({ error: "Transaction is cancelled" }, { status: 400 });

    // Idempotent replay FIRST: a genuine retry of the same key must return the
    // existing row, never be re-judged by the duplicate-reference rule below.
    const existing = await prisma.payment.findUnique({ where: { idempotencyKey: key } });
    if (existing) {
      if (existing.transactionId !== id) {
        return NextResponse.json({ error: "This form was already submitted for a different transaction." }, { status: 409 });
      }
      return NextResponse.json({ payment: existing, deduped: true });
    }

    // One shared rule set, run here exactly as the form runs it. Hard blocks
    // stop the record; warnings (spill / shortfall) require an explicit
    // acknowledgement. Outstanding and next-due come from the finance
    // service, so this check reads the same derived figures everything else
    // does. The confirm step re-checks atomically inside its transaction, so
    // a race can never bypass either.
    const summary = await getTransactionSummary(id);
    if (!summary) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    const refRows = await prisma.payment.findMany({
      where: { transactionId: id, bankReference: { not: null }, status: { not: "CANCELLED" } },
      select: { bankReference: true },
    });
    const validation = validatePayment({
      amount: amt,
      paymentDate: date,
      paymentMethod: typeof paymentMethod === "string" ? paymentMethod : "Bank Transfer",
      bankReference: typeof bankReference === "string" ? bankReference : null,
      contractDate: transaction.createdAt,
      totalPayable: summary.totalPayable,
      outstandingBalance: summary.outstanding,
      dueNow: summary.nextInstallment?.amountDue ?? 0,
      existingReferences: refRows.map((r) => r.bankReference),
      allocationReviewed: allocationReviewed === true,
    });
    if (validation.errors.length > 0) {
      return NextResponse.json({ error: validation.errors[0].message, errors: validation.errors }, { status: 400 });
    }
    if (validation.requiresAcknowledgement) {
      return NextResponse.json(
        { error: validation.warnings[0].message, warnings: validation.warnings, needsAllocationReview: true },
        { status: 409 }
      );
    }
    const wantsCredit = false;

    // Backdated payments are allowed; the audit trail records both dates.
    const backdated = lagosDayKey(date) < lagosDayKey(new Date());

    // Minted before the transaction so the DB callback holds no extra queries.
    const paymentReference = await generateUniquePaymentRef();
    try {
      const { payment } = await prisma.$transaction(async (tx) => {
        const created = await tx.payment.create({
          data: {
            transactionId: id,
            installmentId: null, // confirm resolves the oldest unpaid start
            paymentReference,
            amount: amt,
            paymentDate: date,
            paymentMethod: paymentMethod || "Bank Transfer",
            bankReference: typeof bankReference === "string" && bankReference.trim() ? bankReference.trim() : null,
            notes: notes || null,
            status: "PENDING_VERIFICATION",
            recordedById: session!.user.id,
            source: "MANUAL",
            idempotencyKey: key,
            isCredit: wantsCredit,
            creditAmount: null, // computed at confirm time from live capacity
          },
        });
        await tx.auditEvent.create({
          data: {
            actorId: session!.user.id,
            actorName: session!.user.name ?? session!.user.email ?? "Unknown",
            action: "payment.record",
            entityType: "payment",
            entityId: created.id,
            before: Prisma.JsonNull,
            after: {
              status: "PENDING_VERIFICATION",
              amount: amt,
              paymentReference: created.paymentReference,
              idempotencyKey: key,
              asCredit: wantsCredit,
              backdated,
              paymentDate: date.toISOString(),
            },
          },
        });
        return { payment: created };
      });

      return NextResponse.json({ payment }, { status: 201 });
    } catch (e: unknown) {
      // Lost race on the unique key: return the winner's row (deduped).
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2002") {
        const winner = await prisma.payment.findUnique({ where: { idempotencyKey: key } });
        if (winner) return NextResponse.json({ payment: winner, deduped: true });
      }
      throw e;
    }
  } catch (e: unknown) {
    const { toUserFacingError, logServerError } = await import("@/lib/paymentConfirmation");
    logServerError("record payment", e);
    return NextResponse.json({ error: toUserFacingError(e, "record") }, { status: 500 });
  }
}

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const transaction = await prisma.transaction.findUnique({
    where: { id },
    include: {
      installments: { orderBy: { installmentNumber: "asc" } },
      payments: { orderBy: { createdAt: "desc" } },
      receipts: { orderBy: { issuedAt: "desc" }, omit: { pdfData: true } },
      paymentPlan: true,
    },
  });
  if (!transaction) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
  return NextResponse.json({ transaction });
}
