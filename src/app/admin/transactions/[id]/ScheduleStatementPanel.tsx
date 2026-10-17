"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatNaira } from "@/lib/currency";
import StatementEmailDialog from "./StatementEmailDialog";

export type ScheduleStatementRow = {
  id: string;
  number: string;
  asAt: string;
  outstanding: number;
  emailed: { at: string; to: string } | null;
  defaultTo: string;
};

// Client-facing payment-schedule panel: Preview (DRAFT, never stored/emailed),
// Issue (stored, idempotent per schedule state), and per-statement
// View/Download/Email. The ledger "Statement of Account" panel stays separate.
export default function ScheduleStatementPanel({
  transactionId,
  transactionRef,
  statements,
}: {
  transactionId: string;
  transactionRef: string;
  statements: ScheduleStatementRow[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[] | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);

  async function issue() {
    setBusy(true);
    setMsg(null);
    setErr(null);
    setErrCode(null);
    setProblems(null);
    try {
      const res = await fetch(`/api/admin/transactions/${transactionId}/schedule-statement`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.problems) setProblems(data.problems);
        if (data.code) setErrCode(data.code);
        throw new Error(data.error ?? "Issue failed");
      }
      setMsg(
        data.created
          ? `Issued ${data.statement.number}.`
          : `Schedule unchanged — returned existing ${data.statement.number}.`
      );
      router.refresh();
    } catch (e: unknown) {
      if (!problems) setErr(e instanceof Error ? e.message : "Issue failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-[var(--ops-radius)] p-6 shadow-[var(--ops-shadow-sm)]">
      <h2 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Payment schedule (client)</h2>
      {msg && <div className="mt-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl px-3 py-2">{msg}</div>}
      {err && <div className="mt-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl px-3 py-2">{err}{errCode ? ` (ref: ${errCode})` : ""}</div>}
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={`/api/admin/transactions/${transactionId}/schedule-statement/preview`} target="_blank" className="mono text-[11px] bg-white border border-[var(--ops-border)] rounded-full px-4 py-2 hover:bg-[var(--ops-bg)]">Preview (DRAFT)</a>
        <button onClick={issue} disabled={busy} className="mono text-[11px] bg-[var(--ops-primary)] text-white rounded-full px-4 py-2 font-medium hover:bg-[var(--ops-deep)] disabled:opacity-50">
          {busy ? "Working…" : "Issue schedule statement"}
        </button>
      </div>
      {problems && (
        <div className="mt-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl px-3 py-2">
          <div className="font-medium">Schedule data check failed — issue blocked. Nothing was issued.</div>
          <ul className="list-disc ml-4 mt-1">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </div>
      )}
      {statements.length === 0 ? (
        <p className="mono text-[11px] text-[var(--ops-muted)] mt-3">No schedule statements issued yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {statements.map((s) => (
            <div key={s.id} className="p-3 rounded-xl border border-[var(--ops-border)] bg-[var(--ops-bg)]/30">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="font-mono text-[12px] font-medium text-[var(--ops-primary)]">{s.number}</span>
                  <span className="mono text-[11px] text-[var(--ops-muted)]"> · as at {s.asAt} · outstanding {formatNaira(s.outstanding)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <a href={`/api/admin/transactions/${transactionId}/statements/${s.id}`} target="_blank" className="mono text-[11px] bg-white border border-[var(--ops-border)] rounded-full px-3 py-1.5 hover:bg-[var(--ops-bg)]">View</a>
                  <a href={`/api/admin/transactions/${transactionId}/statements/${s.id}?download=1`} className="mono text-[11px] bg-white border border-[var(--ops-border)] rounded-full px-3 py-1.5 hover:bg-[var(--ops-bg)]">Download</a>
                  <StatementEmailDialog
                    transactionId={transactionId}
                    transactionRef={transactionRef}
                    statement={{ id: s.id, number: s.number, closingBalance: s.outstanding, defaultTo: s.defaultTo, emailed: s.emailed }}
                  />
                </div>
              </div>
              <div className="mono text-[11px] text-[var(--ops-muted)] mt-1">
                {s.emailed ? `Emailed ${s.emailed.at} to ${s.emailed.to}` : "Not emailed"}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
