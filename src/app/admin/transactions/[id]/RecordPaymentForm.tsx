"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { formatNaira } from "@/lib/currency";
import { previewAllocation } from "@/lib/finance/ledger";
import { validatePayment, PAYMENT_METHODS } from "@/lib/paymentValidation";

type Installment = { id: string; installmentNumber: number; type: string; dueDate: string; scheduledAmount: number; paidAmount: number; status: string };

const LAST_METHOD_KEY = "belgrove-last-payment-method";

const labelOf = (inst: Installment) => (inst.type === "INITIAL" ? "Initial payment" : `Month ${inst.installmentNumber}`);

// Free-amount record form: the schedule is a guide, never a gate. The admin
// types whatever the client actually paid; a live preview shows exactly what
// confirming will do. Validation is the SHARED rule set (src/lib/paymentValidation)
// — the same one the server runs, so the two can never drift. Hard blocks stop
// the record; warnings (spill / shortfall) need an explicit acknowledgement.
export default function RecordPaymentForm({
  transactionId,
  installments,
  outstanding,
  totalPaid,
  totalPayable,
  contractDate,
  existingReferences,
  onDone,
}: {
  transactionId: string;
  installments: Installment[];
  outstanding: number;
  totalPaid: number;
  totalPayable: number;
  contractDate?: string | null;
  existingReferences?: string[];
  onDone?: () => void;
}) {
  const router = useRouter();
  const ordered = useMemo(() => [...installments].sort((a, b) => a.installmentNumber - b.installmentNumber), [installments]);
  const suggested = ordered.find((i) => i.scheduledAmount - (i.paidAmount ?? 0) > 0);
  const suggestedDue = suggested ? Math.max(0, suggested.scheduledAmount - (suggested.paidAmount ?? 0)) : 0;

  // One UUID per form open: double-clicks and retries replay the same key and
  // can never mint a second payment. Rotated after each recorded payment.
  const [idemKey, setIdemKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMethod, setPaymentMethod] = useState(() => {
    try {
      return localStorage.getItem(LAST_METHOD_KEY) || "Bank Transfer";
    } catch {
      return "Bank Transfer";
    }
  });
  const [bankReference, setBankReference] = useState("");
  const [notes, setNotes] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverWarnings, setServerWarnings] = useState<string[]>([]);
  const [success, setSuccess] = useState<string | null>(null);

  const amountNum = parseInt(amount.replace(/[^0-9]/g, ""), 10) || 0;

  // Everything the shared rule set needs, recomputed as the form changes.
  const validation = useMemo(
    () =>
      validatePayment({
        amount: amountNum,
        paymentDate: paymentDate ? new Date(paymentDate) : new Date(NaN),
        paymentMethod,
        bankReference,
        contractDate: contractDate ? new Date(contractDate) : null,
        totalPayable,
        outstandingBalance: outstanding,
        dueNow: suggestedDue,
        existingReferences,
        allocationReviewed: reviewed,
      }),
    [amountNum, paymentDate, paymentMethod, bankReference, contractDate, totalPayable, outstanding, suggestedDue, existingReferences, reviewed]
  );
  const blocked = validation.errors.length > 0;
  const warnings = validation.warnings.map((w) => w.message);

  const preview = useMemo(() => {
    if (amountNum <= 0 || blocked) return null;
    try {
      return previewAllocation(
        ordered.map((i) => ({ id: i.id, installmentNumber: i.installmentNumber, scheduledAmount: i.scheduledAmount, paidAmount: i.paidAmount ?? 0, label: labelOf(i) })),
        amountNum,
        totalPayable,
        totalPaid
      );
    } catch {
      return null;
    }
  }, [amountNum, blocked, ordered, totalPayable, totalPaid]);

  // Changing any field invalidates a prior acknowledgement.
  const resetAck = () => {
    setReviewed(false);
    setServerWarnings([]);
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) {
      setError(validation.errors[0].message);
      return;
    }
    if (validation.requiresAcknowledgement) {
      setServerWarnings(warnings);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    setServerWarnings([]);
    setSuccess(null);
    try {
      const res = await fetch(`/api/admin/transactions/${transactionId}/payments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amountNum,
          paymentDate,
          paymentMethod,
          bankReference: bankReference.trim() || undefined,
          notes,
          idempotencyKey: idemKey,
          allocationReviewed: reviewed,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.needsAllocationReview && Array.isArray(data.warnings)) {
          setServerWarnings(data.warnings.map((w: { message: string }) => w.message));
          throw new Error("Tick “I've reviewed the allocation” to confirm this payment.");
        }
        throw new Error(data.error ?? "Failed to record payment");
      }
      try {
        localStorage.setItem(LAST_METHOD_KEY, paymentMethod);
      } catch {
        // ignore storage failures
      }
      setSuccess(
        data.deduped
          ? "This form was already submitted; showing the existing entry instead of a duplicate."
          : "Payment recorded as pending verification. Confirm it in Payment History below to issue the receipt and update totals."
      );
      setAmount("");
      setNotes("");
      setBankReference("");
      setReviewed(false);
      setIdemKey(crypto.randomUUID());
      router.refresh();
      if (onDone) setTimeout(onDone, 1200);
      setTimeout(() => setSuccess(null), 4000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  const showWarnings = warnings.length > 0 || serverWarnings.length > 0;
  const warningList = serverWarnings.length > 0 ? serverWarnings : warnings;

  return (
    <div className="mt-6 border-t border-[var(--ops-border)] pt-6">
      <h3 className="mono text-[11px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Record Payment</h3>
      <p className="mono text-[11px] text-[var(--ops-muted)] mt-1">Two steps: record here (pending), then confirm in Payment History. Confirming issues the receipt, emails the client, and updates totals atomically.</p>
      {suggested && (
        <p className="mono text-[11px] text-[var(--ops-muted)] mt-1">Suggested next: {formatNaira(suggestedDue)} ({labelOf(suggested)}) · Outstanding {formatNaira(outstanding)}</p>
      )}
      {error && <div className="mt-3 bg-red-50 border border-red-200 text-red-700 text-xs rounded-xl px-3 py-2">{error}</div>}
      {success && <div className="mt-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl px-3 py-2">{success}</div>}
      <form onSubmit={handleSubmit} className="mt-4 space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="mono text-[11px] text-[var(--ops-muted)]">Amount received (₦) *</label>
            <input value={amount} onChange={(e) => { setAmount(e.target.value); resetAck(); }} placeholder={suggestedDue ? String(suggestedDue) : "e.g. 2905000"} inputMode="numeric" className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mono text-[11px] text-[var(--ops-muted)]">Payment date *</label>
            <input type="date" value={paymentDate} onChange={(e) => { setPaymentDate(e.target.value); resetAck(); }} className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
          </div>
        </div>
        {preview && preview.lines.length > 0 && (
          <div className="rounded-xl border border-[var(--ops-border)] bg-[var(--ops-bg)]/50 px-3 py-2.5">
            <div className="mono text-[10px] tracking-[0.12em] uppercase text-[var(--ops-muted)]">Confirming will</div>
            <ul className="mt-1 space-y-0.5 text-[12px] text-[var(--ops-text)]">
              {preview.lines.map((l) => (
                <li key={l.installmentId}>
                  {l.clears ? "Clears" : "Part-pays"} {l.label} ({formatNaira(l.applied)}{l.clears ? "" : ` of ${formatNaira(l.scheduled)}`}).
                </li>
              ))}
            </ul>
            <div className="mono text-[11px] text-[var(--ops-muted)] mt-1">Balance after: {formatNaira(preview.balanceAfter)}</div>
          </div>
        )}
        {blocked && !error && (
          <div className="rounded-xl border border-red-300 bg-red-50 px-3 py-2.5">
            <div className="text-[12px] text-red-800">{validation.errors[0].message}</div>
          </div>
        )}
        {showWarnings && (
          <div className="rounded-xl border border-[#FDE68A] bg-[#FFFBEB]/60 px-3 py-2.5">
            <ul className="space-y-1 text-[12px] text-[#92400E]">
              {warningList.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
            <label className="mt-2 flex items-start gap-2 text-[12px] text-[#92400E]">
              <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} className="mt-0.5" />
              <span>I&apos;ve reviewed the allocation and want to record this payment.</span>
            </label>
          </div>
        )}
        <div className="grid md:grid-cols-2 gap-3">
          <div>
            <label className="mono text-[11px] text-[var(--ops-muted)]">Payment method</label>
            <select value={paymentMethod} onChange={(e) => { setPaymentMethod(e.target.value); resetAck(); }} className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm bg-white">{PAYMENT_METHODS.map((m) => <option key={m}>{m}</option>)}</select>
          </div>
          <div>
            <label className="mono text-[11px] text-[var(--ops-muted)]">Bank / teller reference {paymentMethod === "Bank Transfer" ? <span className="text-red-600">*</span> : <span className="normal-case">(optional)</span>}</label>
            <input value={bankReference} onChange={(e) => { setBankReference(e.target.value); resetAck(); }} placeholder="e.g. TRF-88231" className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="mono text-[11px] text-[var(--ops-muted)]">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" className="mt-1 w-full border border-[var(--ops-border)] rounded-xl px-3 py-2 text-sm" />
          </div>
        </div>
        <div className="flex justify-end">
          <button type="submit" disabled={busy || blocked || validation.requiresAcknowledgement} className="text-sm bg-[var(--ops-primary)] text-white rounded-full px-6 py-2.5 font-medium hover:bg-[var(--ops-deep)] disabled:opacity-50">{busy ? "Recording…" : "Record Payment for Verification"}</button>
        </div>
      </form>
    </div>
  );
}
