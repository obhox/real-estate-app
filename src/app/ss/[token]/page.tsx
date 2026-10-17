import { notFound } from "next/navigation";
import Link from "next/link";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { formatNaira } from "@/lib/currency";
import { formatDateDMY } from "@/lib/time";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { buildScheduleStatementModel } from "@/lib/schedule-statement-model";

export const dynamic = "force-dynamic";

export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// Client-facing Schedule Statement page. No login — the unguessable token is
// the authorization (same model as receipts and the ledger statement). Revoked,
// unknown, or wrong-kind tokens render identically (404). Rate-limited per IP.
export default async function ClientScheduleStatementPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const rl = checkRateLimit(`schedule-statement:${clientIp((await headers()) as unknown as Headers)}`, 30, 15 * 60_000);
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
      transaction: { select: { ref: true, customerName: true } },
    },
  });
  if (!stmt || stmt.tokenRevokedAt || stmt.kind !== "SCHEDULE") {
    notFound();
  }

  const model = await buildScheduleStatementModel(prisma, {
    transactionId: stmt.transactionId,
    number: stmt.number,
    draft: false,
    asOf: stmt.asOfDate ?? stmt.createdAt,
  });

  const newer = await prisma.statement.findFirst({
    where: { transactionId: stmt.transactionId, kind: "SCHEDULE", createdAt: { gt: stmt.createdAt } },
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
            <h1 className="fraunces text-[24px] sm:text-[28px] font-bold text-[#16281F]">PAYMENT SCHEDULE</h1>
            <div className="text-left sm:text-right mono text-[11px] text-[#6B6656] break-words">
              <div className="break-all">STATEMENT: {stmt.number}</div>
              <div>ISSUED DATE: {formatDateDMY(stmt.asAt)}</div>
              <div className="break-all">ACCOUNT: {stmt.transaction.ref}</div>
            </div>
          </div>

          <div className="mt-6">
            <div className="mono text-[10px] tracking-[0.12em] uppercase text-[#8B6B4E]">Issued to</div>
            <div className="public text-[14px] font-semibold text-[#16281F] mt-2 break-words">{model.client.name}</div>
            <div className="mono text-[12px] text-[#6B6656]">{model.property.estate}{model.property.unitType ? ` · ${model.property.unitType}` : ""}</div>
          </div>

          <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="border border-[#E4DCC7] rounded-lg p-3">
              <div className="mono text-[10px] tracking-[0.12em] uppercase text-[#8B6B4E]">Total scheduled</div>
              <div className="fraunces text-[16px] font-bold mt-1 text-[#16281F]">{formatNaira(model.totals.scheduled)}</div>
            </div>
            <div className="border border-[#E4DCC7] rounded-lg p-3">
              <div className="mono text-[10px] tracking-[0.12em] uppercase text-[#8B6B4E]">Received</div>
              <div className="fraunces text-[16px] font-bold mt-1 text-[#16281F]">{formatNaira(model.totals.received)}</div>
            </div>
            <div className="border border-[#E4DCC7] rounded-lg p-3 bg-[#FBF7EE]">
              <div className="mono text-[10px] tracking-[0.12em] uppercase text-[#8B6B4E]">{model.fullyPaid ? "Credit" : "Outstanding"}</div>
              <div className="fraunces text-[16px] font-bold mt-1 text-[#16281F]">
                {formatNaira(model.fullyPaid ? model.totals.credit : model.totals.outstanding)}
              </div>
            </div>
          </div>

          <div className="mt-6 overflow-x-auto">
            <table className="w-full border-collapse mono text-[11px]">
              <thead>
                <tr className="text-left text-[#8B6B4E] uppercase tracking-[0.08em]">
                  <th className="py-2 pr-3 border-b border-[#E4DCC7] font-normal">Due date</th>
                  <th className="py-2 pr-3 border-b border-[#E4DCC7] font-normal">Installment</th>
                  <th className="py-2 pr-3 border-b border-[#E4DCC7] font-normal text-right">Scheduled</th>
                  <th className="py-2 pr-3 border-b border-[#E4DCC7] font-normal text-right">Received</th>
                  <th className="py-2 border-b border-[#E4DCC7] font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {model.rows.map((r, i) => (
                  <tr key={i} className="align-top">
                    <td className="py-2 pr-3 border-b border-[#F2ECDD]">{r.dueDate}</td>
                    <td className="py-2 pr-3 border-b border-[#F2ECDD] text-[#16281F]">{r.label}</td>
                    <td className="py-2 pr-3 border-b border-[#F2ECDD] text-right">{formatNaira(r.scheduled)}</td>
                    <td className="py-2 pr-3 border-b border-[#F2ECDD] text-right">{formatNaira(r.received)}</td>
                    <td className="py-2 border-b border-[#F2ECDD]">{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 bg-[#C79A46] rounded-lg p-4 text-white">
            {model.fullyPaid ? (
              <>
                <div className="mono text-[10px] tracking-[0.12em] uppercase opacity-90">Fully paid</div>
                <div className="public text-[13px] mt-1">{model.client.name} has completed this payment plan{model.settledOn ? ` (settled ${model.settledOn})` : ""}.</div>
              </>
            ) : (
              <>
                <div className="mono text-[10px] tracking-[0.12em] uppercase opacity-90">Next payment due</div>
                {model.nextDue ? (
                  <div className="fraunces text-[18px] font-bold mt-1">
                    {formatNaira(model.nextDue.amount)} · {model.nextDue.label} · {model.nextDue.dueDate}
                  </div>
                ) : (
                  <div className="public text-[13px] mt-1">No scheduled payment remaining.</div>
                )}
              </>
            )}
          </div>

          <p className="public text-[11px] leading-[1.5] text-[#8B6B4E] mt-4 border-t border-[#E4DCC7] pt-4">
            This is the payment schedule as issued on {formatDateDMY(stmt.asAt)}. Payments received may have changed since.
          </p>
          {newer && (
            <p className="public text-[12px] mt-2">
              A newer schedule exists: <Link href={`/ss/${newer.token}`} className="text-[#16281F] font-bold underline underline-offset-2">{newer.number} (issued {formatDateDMY(newer.asAt)})</Link>
            </p>
          )}

          <div className="mt-6 flex items-center justify-center">
            <a href={`/api/s/${token}/pdf`} className="mono text-[11px] bg-[#16281F] text-[#F5EFE2] px-4 py-2 rounded-full hover:bg-[#1B2E23]">Download PDF</a>
          </div>
        </div>
      </div>
      <div className="max-w-[800px] mx-auto mt-6 text-center mono text-[11px] text-[#8B6B4E]">
        Keep this private link safe — it always shows your payment schedule.
      </div>
    </div>
  );
}
