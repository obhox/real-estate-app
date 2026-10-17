import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import { buildScheduleStatementModel } from "@/lib/schedule-statement-model";
import { renderScheduleStatementPdf } from "@/lib/schedule-statement-pdf";
import { chromiumErrorCode } from "@/lib/statement-chromium";
import { logServerError } from "@/lib/paymentConfirmation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// DRAFT preview of the Schedule Statement: rendered on the fly (model →
// template → Chromium), marked DRAFT, no number, no stamp. Nothing stored and
// never emailable. Never cached.
export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const txn = await prisma.transaction.findUnique({ where: { id }, select: { ref: true } });
    if (!txn) return NextResponse.json({ error: "Transaction not found" }, { status: 404 });
    const model = await buildScheduleStatementModel(prisma as never, { transactionId: id, draft: true });
    const pdf = await renderScheduleStatementPdf(model, {});
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="Belgrove-Schedule-${txn.ref}-DRAFT.pdf"`,
        "Cache-Control": "private, no-store, must-revalidate",
      },
    });
  } catch (e) {
    logServerError(`schedule statement preview ${id}`, e);
    return NextResponse.json(
      { error: "Couldn't build the preview right now. Please try again.", code: chromiumErrorCode(e) },
      { status: 500 }
    );
  }
}
