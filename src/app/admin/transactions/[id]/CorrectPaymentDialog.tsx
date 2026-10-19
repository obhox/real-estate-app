"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { formatNaira } from "@/lib/currency";

// Correct a confirmed payment: visible reversal + replacement entry, linked
// both ways, in one transaction. Never edits amounts in place. Nothing is
// emailed by this action — replacements go out with the correction email.
export default function CorrectPaymentDialog({
  transactionId,
  paymentId,
  paymentLabel,
  onDone,
}: {
  transactionId: string;
  paymentId: string;
  paymentLabel: string;
  onDone?: () => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState<null | {
    amount: number;
    paymentReference: string;
    paymentDate: string;
    bankReference: string | null;
    paymentMethod: string | null;
  }>(null);
  const [newAmount, setNewAmount] = useState("");
  const [reason, setReason] = useState("");
  const [verificationNote, setVerificationNote] = useState("");
  const [bankReference, setBankReference] = useState("");
  const [paymentDate, setPaymentDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function openDialog() {
    setOpen(true);
    setError(null);
    setResult(null);
    setWarning(null);
    if (loaded) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/transactions/${transactionId}/payments/${paymentId}/confirm`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Couldn't load payment");
      const p = data.payment;
      setLoaded({
        amount: p.amount,
        paymentReference: p.paymentReference,
        paymentDate: new Date(p.paymentDate).toISOString().slice(0, 10),
        bankReference: p.bankReference ?? null,
        paymentMethod: p.paymentMethod ?? null,
      });
      setNewAmount(String(p.amount));
      setBankReference(p.bankReference ?? "");
      setPaymentDate(new Date(p.paymentDate).toISOString().slice(0, 10));
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't load payment");
    } finally {
      setLoading(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const amt = parseInt(newAmount.replace(/[^0-9]/g, ""), 10) || 0;
    if (amt <= 0) {
      setError("Enter a whole-naira corrected amount");
      return;
    }
    if (reason.trim().length < 3) {
      setError("A reason is required");
      return;
    }
    if (!verificationNote.trim()) {
      setError("Bank verification evidence is required (statement line, date, confirmer)");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/transactions/${transactionId}/payments/${paymentId}/correct`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newAmount: amt,
          reason: reason.trim(),
          verificationNote: verificationNote.trim(),
          bankReference: bankReference.trim() || undefined,
          paymentDate: paymentDate || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Correction failed");
      setResult(
        data.deduped
          ? "A replacement already exists for this payment — no duplicate created."
          : `Corrected: replacement payment issued, receipt ${data.receipt?.ref ?? ""}. Original receipt ${data.originalReceiptRef ?? ""} voided. Nothing emailed — use the correction email to notify the client.`
      );
      // Committed, but the receipt PDF needs a retry: the correction did land,
      // so this must not read as a failure.
      if (data.warning) setWarning(data.warning);
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Correction failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={openDialog}
        className="mono text-[11px] bg-white border border-[var(--ops-border)] text-[var(--ops-muted)] rounded-full px-3.5 py-1.5 hover:text-[var(--ops-text)] transition-colors"
      >
        Correct
      </button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`Correct ${paymentLabel}`}>
          <div className="absolute inset-0 bg-black/40" onClick={() => { if (!busy) { setOpen(false); if (onDone && result) onDone(); } }} />
          <div className="relative w-full max-w-[480px] max-h-[90vh] overflow-y-auto bg-[var(--ops-surface)] border border-[var(--ops-border)] rounded-2xl p-6 shadow-xl">
            <div className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Correct payment</div>
            <div className="text-[15px] font-medium text-[var(--ops-text)] mt-1">{paymentLabel}</div>
            {loading && <p className="mono text-[11px] text-[var(--ops-muted)] mt-3">Loading…</p>}
            {error && <div className="mt-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl px-3 py-2">{error}</div>}
            {result && <div className="mt-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl px-3 py-2">{result}</div>}
            {warning && <div className="mt-2 bg-amber-50 border border-amber-200 text-amber-800 text-xs rounded-xl px-3 py-2">{warning}</div>}
            {loaded && !result && (
              <form onSubmit={submit} className="mt-4 space-y-3">
                <div className="mono text-[11px] text-[var(--ops-muted)]">
                  Recorded: {formatNaira(loaded.amount)} · {loaded.paymentReference}{loaded.bankReference ? ` · bank ${loaded.bankReference}` : ""}
                </div>
                <div>
                  <label className="mono text-[11px] text-[var(--ops-muted)]">Corrected amount (₦) *</label>
                  <input value={newAmount} onChange={(e) => setNewAmount(e.target.value)} inputMode="numeric" className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mono text-[11px] text-[var(--ops-muted)]">Payment date</label>
                    <input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="mono text-[11px] text-[var(--ops-muted)]">Bank reference</label>
                    <input value={bankReference} onChange={(e) => setBankReference(e.target.value)} placeholder={loaded.bankReference ?? "none on file"} className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
                  </div>
                </div>
                <div>
                  <label className="mono text-[11px] text-[var(--ops-muted)]">Reason *</label>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Amount mistyped to fit schedule" className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="mono text-[11px] text-[var(--ops-muted)]">Bank verification *</label>
                  <input value={verificationNote} onChange={(e) => setVerificationNote(e.target.value)} placeholder="e.g. Checked against bank statement line dated 11-08-2026, confirmed by Ada" className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
                </div>
                <p className="mono text-[10px] text-[var(--ops-muted)]">Reverses the original and issues a replacement with a new receipt. The original receipt is voided, never rewritten. Nothing is emailed.</p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setOpen(false)} className="mono text-[11px] text-[var(--ops-muted)] underline underline-offset-4">Cancel</button>
                  <button type="submit" disabled={busy} className="mono text-[11px] bg-[var(--ops-primary)] text-white rounded-full px-4 py-2 font-medium disabled:opacity-50">{busy ? "Correcting…" : "Correct payment"}</button>
                </div>
              </form>
            )}
            {result && (
              <div className="mt-3 flex justify-end">
                <button onClick={() => { setOpen(false); if (onDone) onDone(); }} className="mono text-[11px] bg-[var(--ops-primary)] text-white rounded-full px-4 py-2 font-medium">Done</button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
