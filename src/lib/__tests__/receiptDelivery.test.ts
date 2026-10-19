import { describe, it, expect, vi } from "vitest";
import { generateAndStoreReceiptPdf, persistReceiptEmailSent } from "../receiptDelivery";

function mockDb() {
  const update = vi.fn(async () => ({}));
  return { db: { receipt: { update } }, update };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("generateAndStoreReceiptPdf", () => {
  it("succeeds with a slow renderer (the >5s case that used to kill the transaction)", async () => {
    const { db, update } = mockDb();
    const render = vi.fn(async () => {
      await sleep(300); // stands in for a multi-second PDF render
      return Buffer.from("pdf-bytes");
    });

    const result = await generateAndStoreReceiptPdf({
      db,
      receiptId: "rcpt-1",
      ref: "BEL-2026-00001",
      render,
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBe(null);
    expect(result.bytes).toBeInstanceOf(Buffer);
    expect(render).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({
      where: { id: "rcpt-1" },
      data: { pdfStatus: "GENERATED", pdfData: expect.any(Buffer) },
    });
  });

  it("PDF render failure leaves the payment confirmed and marks pdfStatus FAILED without throwing", async () => {
    const { db, update } = mockDb();

    const result = await generateAndStoreReceiptPdf({
      db,
      receiptId: "rcpt-1",
      ref: "BEL-2026-00001",
      render: async () => {
        throw new Error("font subset missing");
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("font subset missing");
    expect(update).toHaveBeenCalledWith({
      where: { id: "rcpt-1" },
      data: { pdfStatus: "FAILED" },
    });
  });

  it("optional legacy store failure is recorded, not thrown", async () => {
    const { db, update } = mockDb();

    const result = await generateAndStoreReceiptPdf({
      db,
      receiptId: "rcpt-1",
      ref: "BEL-2026-00001",
      pdfPath: "storage/receipts/BEL-2026-00001.pdf",
      render: async () => Buffer.from("pdf-bytes"),
      writeFile: async () => {
        throw new Error("ENOSPC: no space left on device /tmp/x.pdf");
      },
    });

    expect(result.ok).toBe(false);
    expect(update).toHaveBeenCalledWith({
      where: { id: "rcpt-1" },
      data: { pdfStatus: "FAILED" },
    });
  });

  it("never throws even when the bookkeeping write itself fails", async () => {
    const db = { receipt: { update: vi.fn(async () => { throw new Error("db down"); }) } };

    const result = await generateAndStoreReceiptPdf({
      db,
      receiptId: "rcpt-1",
      ref: "BEL-2026-00001",
      render: async () => Buffer.from("pdf-bytes"),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBe(null);
    expect(result.bytes).toBeInstanceOf(Buffer);
  });
});

describe("persistReceiptEmailSent", () => {
  it("writes only the minimal proof: resendEmailId + sentAt", async () => {
    const { db, update } = mockDb();
    await persistReceiptEmailSent({ db, receiptId: "rcpt-1", ref: "RCT-1", resendEmailId: "msg-abc" });
    expect(update).toHaveBeenCalledWith({
      where: { id: "rcpt-1" },
      data: { resendEmailId: "msg-abc", sentAt: expect.any(Date) },
    });
  });

  it("never throws when the bookkeeping write fails", async () => {
    const db = { receipt: { update: vi.fn(async () => { throw new Error("db down"); }) } };
    await expect(
      persistReceiptEmailSent({ db, receiptId: "rcpt-1", ref: "RCT-1", resendEmailId: "msg-abc" })
    ).resolves.toBeUndefined();
  });

  it("has no failure write path: a failed send leaves prior proof untouched", async () => {
    // The module exposes no function that writes a failed state — failures
    // simply never call persist. Asserted structurally: only the success
    // helper exists alongside the PDF helpers.
    const mod = await import("../receiptDelivery");
    expect(Object.keys(mod).sort()).toEqual(["generateAndStoreReceiptPdf", "persistReceiptEmailSent"]);
  });
});
