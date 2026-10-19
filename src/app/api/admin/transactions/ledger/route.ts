import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { isInternalRole } from "@/lib/authz";
import type { Prisma } from "@/generated/prisma/client";
import { lagosToUtc } from "@/lib/time";
import { buildCompanyLedgerModel } from "@/lib/company-ledger";
import { renderCompanyLedgerPdf } from "@/lib/company-ledger-pdf";

export const dynamic = "force-dynamic";

// Company Sales Ledger: every transaction on ONE sheet, oldest first, with a
// per-account running balance and the company-wide total owed. All figures
// come from the ledger service via buildCompanyLedgerModel — this route only
// authenticates, filters, and hands the rows to the renderer:
//   - sale (debit) per transaction, dated at the contract date;
//   - payment (credit) per CONFIRMED payment;
//   - the "Confirmed payments only" toggle filters PAYMENT rows only, never a
//     sale; the "Include corrections" toggle greys reversed entries without
//     moving any balance.
// Capped at 500 transactions per export.
const LEDGER_CAP = 500;
const VALID_STATUSES = ["DRAFT", "ACTIVE", "PAID_IN_FULL", "CANCELLED"] as const;

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!isInternalRole(session?.user?.role)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() ?? "";
  const status = params.get("status") ?? "";
  const plan = params.get("plan") ?? "";
  const fromStr = params.get("from")?.trim() ?? "";
  const toStr = params.get("to")?.trim() ?? "";
  const showTest = params.get("showTest") === "1";
  // Defaults: confirmed payments only, corrections off. `confirmedOnly=0`
  // shows pending payments; `corrections=1` shows reversed entries.
  const confirmedOnly = params.get("confirmedOnly") !== "0";
  const includeCorrections = params.get("corrections") === "1";

  const where: Prisma.TransactionWhereInput = {};
  if (!showTest) where.isTest = false;
  if (status) {
    if (!(VALID_STATUSES as readonly string[]).includes(status)) {
      return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
    }
    where.status = status as (typeof VALID_STATUSES)[number];
  }
  if (plan) where.paymentPlanId = plan;
  if (q) {
    where.OR = [
      { ref: { contains: q, mode: "insensitive" } },
      { customerName: { contains: q, mode: "insensitive" } },
      { customerEmail: { contains: q, mode: "insensitive" } },
      { estate: { contains: q, mode: "insensitive" } },
      { plotCode: { contains: q, mode: "insensitive" } },
    ];
  }

  // Date range applies to ROW dates (sale / payment dates), Lagos calendar
  // days, inclusive. Rows before the range compress into the opening balance.
  let from: Date | null = null;
  let to: Date | null = null;
  try {
    if (fromStr) from = lagosToUtc(fromStr);
    if (toStr) to = lagosToUtc(toStr);
  } catch {
    return NextResponse.json({ error: "Invalid from/to date (use YYYY-MM-DD)" }, { status: 400 });
  }
  if (from && to && to < from) {
    return NextResponse.json({ error: "Invalid date range: to must be after from" }, { status: 400 });
  }

  const transactions = await prisma.transaction.findMany({
    where,
    orderBy: { createdAt: "asc" },
    take: LEDGER_CAP,
    select: {
      id: true,
      ref: true,
      customerName: true,
      estate: true,
      plotCode: true,
      unitType: true,
      totalPayable: true,
      outstandingBalance: true,
      status: true,
      contractDate: true,
      createdAt: true,
    },
  });

  const model = await buildCompanyLedgerModel(prisma as never, {
    transactions,
    from,
    to,
    confirmedOnly,
    includeCorrections,
  });
  const pdfBuffer = await renderCompanyLedgerPdf(model);

  const filename = `belgrove-ledger-${new Date().toISOString().split("T")[0]}.pdf`;
  return new NextResponse(new Uint8Array(pdfBuffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
