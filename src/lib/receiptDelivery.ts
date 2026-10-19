import { logServerError } from "./paymentConfirmation";

// Post-commit receipt side effects. These run AFTER the confirmation
// transaction commits — PDF rendering and email can each take seconds, and
// none of them may ever roll back a CONFIRMED payment. No filesystem
// anywhere: the PDF bytes are stored on the receipt row (pdfData) once and
// reused for every send/download. A PDF failure is recorded on the receipt
// row (pdfStatus) and logged; helpers never throw for delivery failures.
// Email has no failure column: not-emailed is simply sentAt == null.

export interface ReceiptStatusStore {
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
}

export interface DeliveryDb {
  receipt: ReceiptStatusStore;
}

function shortMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error ?? "unknown error");
  return msg.slice(0, 500);
}

export async function generateAndStoreReceiptPdf(opts: {
  db: DeliveryDb;
  receiptId: string;
  ref: string;
  // Injected so tests can simulate a >5s render and routes stay thin.
  render: () => Buffer | Promise<Buffer>;
  // Legacy file-write hook (dev scripts only). Production passes nothing —
  // the bytes go to the receipt row instead, never to disk.
  writeFile?: (filePath: string, data: Buffer) => Promise<void>;
  pdfPath?: string;
}): Promise<{ ok: boolean; error: string | null; bytes?: Buffer }> {
  let buffer: Buffer;
  try {
    buffer = await opts.render();
  } catch (error) {
    logServerError(`receipt ${opts.ref}: PDF render failed`, error);
    await markPdf(opts.db, opts.receiptId, "FAILED");
    return { ok: false, error: shortMessage(error) };
  }
  try {
    if (opts.writeFile && opts.pdfPath) {
      await opts.writeFile(opts.pdfPath, buffer);
    }
  } catch (error) {
    logServerError(`receipt ${opts.ref}: PDF store failed`, error);
    await markPdf(opts.db, opts.receiptId, "FAILED");
    return { ok: false, error: shortMessage(error) };
  }
  await markPdf(opts.db, opts.receiptId, "GENERATED", buffer);
  return { ok: true, error: null, bytes: buffer };
}

async function markPdf(
  db: DeliveryDb,
  receiptId: string,
  pdfStatus: "GENERATED" | "FAILED",
  pdfData?: Buffer
): Promise<void> {
  try {
    await db.receipt.update({
      where: { id: receiptId },
      data: { pdfStatus, ...(pdfData ? { pdfData } : {}) },
    });
  } catch (error) {
    // The payment is already confirmed; a bookkeeping write failing must not
    // surface as a confirmation failure — log it loudly instead.
    logServerError(`receipt ${receiptId}: failed to persist pdfStatus=${pdfStatus}`, error);
  }
}

export async function persistReceiptEmailSent(opts: {
  db: DeliveryDb;
  receiptId: string;
  ref: string;
  resendEmailId: string | null;
}): Promise<void> {
  // Minimal permanent record: which Resend message proves this receipt was
  // emailed, and when. Failures are NEVER written here — a failed attempt
  // must not overwrite a prior success (the RCT-2026-69739 drift: a later
  // 409 flipped a sent receipt back to failed). Not-emailed is simply
  // sentAt == null; the admin retries with the Resend button.
  try {
    await opts.db.receipt.update({
      where: { id: opts.receiptId },
      data: {
        resendEmailId: opts.resendEmailId,
        sentAt: new Date(),
      },
    });
  } catch (error) {
    logServerError(`receipt ${opts.ref}: failed to persist email proof`, error);
  }
}
