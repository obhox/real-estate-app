import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { issueScheduleStatement, StatementDataError } from "@/lib/statements";
import { chromiumErrorCode } from "@/lib/statement-chromium";
import { toUserFacingLedgerError, logLedgerError } from "@/lib/finance/ledger";

export const maxDuration = 60;

// Download: serves the stored schedule statement for the current schedule
// (issues one first when none exists or a payment changed it since). Downloading
// NEVER emails.
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const { statement } = await issueScheduleStatement(prisma as never, {
      transactionId: id,
      actorId: session!.user.id,
      actorName: session!.user.name ?? session!.user.email ?? "Unknown",
    });
    const row = await prisma.statement.findUnique({ where: { id: statement.id }, select: { number: true, pdfData: true } });
    if (!row) return NextResponse.json({ error: "Statement not found" }, { status: 404 });
    return new NextResponse(new Uint8Array(Buffer.from(row.pdfData)), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="Belgrove-${row.number}.pdf"`,
        "Cache-Control": "private, no-store, must-revalidate",
      },
    });
  } catch (e) {
    logLedgerError(`schedule statement download ${id}`, e);
    return NextResponse.json({ error: toUserFacingLedgerError(e), code: chromiumErrorCode(e) }, { status: 500 });
  }
}

// Generate (issue) the client-facing Schedule Statement: stored immutable PDF
// + number + token on /ss/[token]. Same schedule state → existing statement
// returned; new confirmed payment → a new one. Invariant failures BLOCK
// generation (409 + problem list). Generating NEVER sends anything.
export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const result = await issueScheduleStatement(prisma as never, {
      transactionId: id,
      actorId: session!.user.id,
      actorName: session!.user.name ?? session!.user.email ?? "Unknown",
    });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (e) {
    if (e instanceof StatementDataError) {
      return NextResponse.json(
        { error: "Schedule statement data check failed — generation blocked.", problems: e.problems },
        { status: 409 }
      );
    }
    logLedgerError(`issue schedule statement ${id}`, e);
    return NextResponse.json(
      { error: toUserFacingLedgerError(e), code: chromiumErrorCode(e) },
      { status: 500 }
    );
  }
}
