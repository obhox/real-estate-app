import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { statementVerifyUrl, scheduleStatementVerifyUrl } from "@/lib/statements";
import { formatDisplayName } from "@/lib/formatName";
import { formatSignedNaira } from "@/lib/currency";
import { logServerError } from "@/lib/paymentConfirmation";

export const maxDuration = 60;

// THE only statement email path: explicit admin action with confirmation.
// Requires the statement id + confirm:true; anything else is rejected.
// Fresh idempotency key per Send click; timeout retries reuse the handed-back
// key with a byte-identical body (same contract as receipt resends).
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string; statementId: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id, statementId } = await ctx.params;
  const body = await request.json().catch(() => null);
  if (!body || body.confirm !== true) {
    return NextResponse.json({ error: "Explicit confirmation is required (confirm:true)." }, { status: 400 });
  }
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
    return NextResponse.json({ error: "A valid recipient email is required." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
  const key =
    typeof body.idempotencyKey === "string" && body.idempotencyKey.length >= 8
      ? body.idempotencyKey.slice(0, 120)
      : `statement-email:${statementId}:${randomUUID()}`;

  const stmt = await prisma.statement.findFirst({
    where: { id: statementId, transactionId: id },
    include: { transaction: { select: { ref: true, customerName: true } } },
  });
  if (!stmt) return NextResponse.json({ error: "Statement not found" }, { status: 404 });

  const isSchedule = stmt.kind === "SCHEDULE";
  const viewUrl = isSchedule ? scheduleStatementVerifyUrl(stmt.token) : statementVerifyUrl(stmt.token);
  const subject = isSchedule
    ? `Your payment schedule, ${stmt.transaction.ref}`
    : `Your statement of account, ${stmt.transaction.ref}`;
  const html =
    `<p>Hi ${formatDisplayName(stmt.transaction.customerName)},</p>` +
    (isSchedule
      ? `<p>Your payment schedule <strong>${stmt.number}</strong> is attached as PDF. ` +
        `Outstanding balance: <strong>${formatSignedNaira(stmt.closingBalance)}</strong>.</p>`
      : `<p>Your statement of account <strong>${stmt.number}</strong> is attached as PDF. ` +
        `Outstanding balance as at the statement date: <strong>${formatSignedNaira(stmt.closingBalance)}</strong>.</p>`) +
    (note ? `<p>${note.replace(/</g, "&lt;")}</p>` : "") +
    `<p>You can also view or re-download it anytime at:<br/><a href="${viewUrl}">${viewUrl}</a></p>` +
    `<p>Belgrove Homes and Properties Limited<br/>www.belgrovehomes.com · info@belgrovehomes.com · +234 8103760063</p>`;

  const { sendEmail } = await import("@/lib/email/sendEmail");
  let result: { sent: boolean; error: string | null; providerMessageId?: string | null };
  try {
    result = await sendEmail({
      to,
      subject,
      html,
      attachments: [{ filename: `Belgrove-${stmt.number}.pdf`, content: Buffer.from(stmt.pdfData), contentType: "application/pdf" }],
      idempotencyKey: key,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Email failed";
    logServerError(`statement email ${statementId}`, e);
    result = { sent: false, error: msg };
  }

  if (result.sent) {
    await prisma.statement.update({
      where: { id: stmt.id },
      data: { emailSentAt: new Date(), emailRecipient: to, resendEmailId: result.providerMessageId ?? null },
    });
    await prisma.auditEvent.create({
      data: {
        actorId: session!.user.id,
        actorName: session!.user.name ?? session!.user.email ?? "Unknown",
        action: "statement.email",
        entityType: "statement",
        entityId: stmt.id,
        before: { emailed: false },
        after: { sent: true, to, number: stmt.number, resendEmailId: result.providerMessageId ?? null },
      },
    });
    return NextResponse.json({ sent: true, to, resendEmailId: result.providerMessageId ?? null });
  }
  if (result.error && /timed out/i.test(result.error)) {
    return NextResponse.json(
      { error: "The send timed out and may have delivered. Check Resend before retrying.", idempotencyKey: key, retryable: true },
      { status: 503 }
    );
  }
  return NextResponse.json({ error: result.error ?? "Email failed" }, { status: 502 });
}
