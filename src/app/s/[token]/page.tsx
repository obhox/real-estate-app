import { notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { formatDisplayName } from "@/lib/formatName";
import { formatSignedNaira } from "@/lib/currency";
import { formatDateDMY } from "@/lib/time";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// Client-facing statement page. No login — the unguessable token in the URL
// is the authorization (same model as receipts). Revoked or unknown tokens
// render identically (404). Rate-limited per IP. Shows nothing beyond this
// one statement.
export default async function ClientStatementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rl = checkRateLimit(`statement:${clientIp((await headers()) as unknown as Headers)}`, 30, 15 * 60_000);
  if (!rl.ok) {
    return (
      <div className="min-h-screen bg-[#F7F2E7] flex items-center justify-center px-6 py-12">
        <div className="bg-white border border-[#E4DCC7] rounded-xl p-8 max-w-[560px] w-full text-center">
          <h1 className="fraunces text-[22px] text-[#16281F]">Too many requests</h1>
          <p className="public text-[13px] text-[#6B6656] mt-2">Please wait a little while and try again.</p>
        </div>
      </div>
    );
  }
  const stmt = await prisma.statement.findUnique({
    where: { token },
    omit: { pdfData: true },
    include: {
      transaction: { select: { ref: true, customerName: true, customerEmail: true } },
    },
  });
  if (!stmt || stmt.tokenRevokedAt || stmt.kind !== "LEDGER") {
    notFound();
  }

  const newer = await prisma.statement.findFirst({
    where: { transactionId: stmt.transactionId, kind: "LEDGER", createdAt: { gt: stmt.createdAt } },
    orderBy: { createdAt: "desc" },
    select: { token: true, number: true, asAt: true },
  });

  return (
    <div className="min-h-screen bg-[#F7F2E7] py-6 sm:py-8 px-3 sm:px-6">
      <div className="w-full max-w-[800px] mx-auto bg-white border border-[#E4DCC7] rounded-xl overflow-hidden shadow-[0_8px_24px_rgba(22,40,31,0.08)]">
        <div className="px-4 sm:px-8 pt-6 sm:pt-8 pb-6 border-b border-[#E4DCC7] flex flex-col sm:flex-row sm:justify-between gap-4 sm:gap-6">
          <div className="flex items-center gap-3 min-w-0">
            <img src="/belgrove-icon.png" alt="Belgrove Homes" width={40} height={32} className="shrink-0" />
            <div className="min-w-0">
              <div className="fraunces text-[13px] font-bold tracking-wide text-[#16281F] break-words">BELGROVE HOMES AND PROPERTIES LIMITED</div>
              <div className="mono text-[11px] text-[#6B6656] mt-1 break-words">Suite 25, Lebrex Plaza, 47 Ajose Adeogun St, Utako, Abuja 900108, Federal Capital Territory</div>
            </div>
          </div>
          <div className="mono text-[11px] text-[#16281F] text-left sm:text-right leading-[1.6] shrink-0 break-words">
            <div>www.belgrovehomes.com</div>
            <div className="break-all">info@belgrovehomes.com</div>
            <div>+234 8103760063</div>
          </div>
        </div>

        <div className="px-4 sm:px-8 py-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between sm:items-start pt-2">
            <h1 className="fraunces text-[24px] sm:text-[28px] font-bold text-[#16281F]">STATEMENT OF ACCOUNT</h1>
            <div className="text-left sm:text-right mono text-[11px] text-[#6B6656] break-words">
              <div className="break-all">STATEMENT: {stmt.number}</div>
              <div>ISSUED DATE: {formatDateDMY(stmt.asAt)}</div>
              <div className="break-all">ACCOUNT: {stmt.transaction.ref}</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mono text-[10px] tracking-[0.12em] uppercase text-[#8B6B4E]">Issued to</div>
            <div className="public text-[14px] font-semibold text-[#16281F] mt-2 break-words">{formatDisplayName(stmt.transaction.customerName)}</div>
            <div className="mono text-[12px] text-[#6B6656] break-all">{stmt.transaction.customerEmail}</div>
          </div>

          <div className="mt-4 bg-[#C79A46] rounded-lg p-4 text-white">
            <div className="mono text-[10px] tracking-[0.12em] uppercase opacity-90">Closing balance</div>
            <div className="fraunces text-[20px] font-bold mt-1">{formatSignedNaira(stmt.closingBalance)}</div>
          </div>

          <p className="public text-[11px] leading-[1.5] text-[#8B6B4E] mt-4 border-t border-[#E4DCC7] pt-4">
            This is the statement as issued on {formatDateDMY(stmt.asAt)}. Balances may have changed since.
          </p>
          {newer && (
            <p className="public text-[12px] mt-2">
              A newer statement exists: <Link href={`/s/${newer.token}`} className="text-[#16281F] font-bold underline underline-offset-2">{newer.number} (issued {formatDateDMY(newer.asAt)})</Link>
            </p>
          )}

          <div className="mt-6 flex items-center justify-center">
            <a href={`/api/s/${token}/pdf`} className="mono text-[11px] bg-[#16281F] text-[#F5EFE2] px-4 py-2 rounded-full hover:bg-[#1B2E23]">Download PDF</a>
          </div>
        </div>
      </div>
      <div className="max-w-[800px] mx-auto mt-6 text-center mono text-[11px] text-[#8B6B4E]">
        Keep this private link safe — it always shows your statement.
      </div>
    </div>
  );
}
