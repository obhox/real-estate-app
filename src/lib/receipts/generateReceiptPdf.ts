import { jsPDF } from "jspdf";
import { amountToWords } from "./amountToWords";
import { formatNaira } from "../currency";
import { formatDisplayName } from "../formatName";
import { receiptAmountsRows, settlementLabel } from "../receipt-amounts";
import { drawLetterhead } from "../documents/brand";
import { loadSignatureBase64, embedNotoSans } from "./pdf-assets";

type PaymentRow = { date: string; method: string; amount: number };

// Full-history row: every confirmed payment up to and including this one,
// with its receipt ref and the running balance after it.
export type ReceiptHistoryRowInput = {
  date: string;
  method: string;
  amount: number;
  receiptRef: string | null;
  runningBalance: number;
  isCurrent: boolean;
};

export type ReceiptData = {
  ref: string;
  issuedDate: string;
  clientName: string;
  clientAddress: string; // ignored for Issued To — keep for compat but not rendered as property
  clientPhone: string;
  clientEmail: string;
  estateName: string;
  unitType: string;
  plotCode: string;
  amountPaid: number;
  soldPrice: number;
  discount?: number;
  payments: PaymentRow[];
  // Full history (preferred): when present, the table shows every payment
  // with receipt refs and running balances; `payments` is the legacy
  // single-row fallback.
  history?: ReceiptHistoryRowInput[];
  // Account reference line: transaction ref + booking ref (separate from the
  // receipt number, which stays RCT-…).
  accountRef?: string;
  // Replacement line: "Replaces RCT-…" for corrected receipts.
  replacesRef?: string | null;
  // Settlement label: PART PAYMENT while balance remains, FINAL when settled.
  label?: "PART PAYMENT" | "FINAL PAYMENT, ACCOUNT SETTLED";
  // This payment's own channel details.
  paymentDate?: string;
  paymentMethodLabel?: string;
  bankReference?: string | null;
  receiptUrl: string;
  qrDataUrl?: string;
  // Extended for new property table + payment details (spec 13/14)
  unitPrice?: number;
  plotQuantity?: number;
  paymentPlanName?: string;
  interestAmount?: number;
  totalPayable?: number;
  previouslyPaid?: number;
  totalPaidAfter?: number;
  outstandingBalance?: number;
  transactionRef?: string;
  // Client-facing settlement sentence shown when the plan is fully paid
  // (from settlementCopy) — e.g. "Plan fully paid on 14 Mar 2027. No further
  // payments due."
  settlementNote?: string | null;
};

function drawPersonIcon(doc: jsPDF, x: number, y: number, size: number) {
  // PDF-compatible vector person icon — no icon font, no unicode glyph
  // Head circle + shoulders arc, filled with brand color
  const headR = size * 0.32;
  const headY = y - size * 0.28;
  const bodyW = size * 0.9;
  const bodyH = size * 0.5;
  const bodyY = y + size * 0.22;
  doc.setFillColor(22, 40, 31);
  // head
  doc.circle(x, headY, headR, "F");
  // shoulders — use ellipse for rounded shoulders
  (doc as any).ellipse(x, bodyY, bodyW / 2, bodyH / 2, "F");
  // small white cut to separate head/body visually (optional)
  doc.setFillColor(255, 255, 255);
  doc.circle(x, headY + headR * 0.6, headR * 0.35, "F");
  doc.setFillColor(22, 40, 31);
}

export function generateReceiptPdf(data: ReceiptData): Buffer {
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
  embedNotoSans(doc); // throws when fonts are unavailable — never helvetica
  const fontName = "NotoSans";

  const W = doc.internal.pageSize.getWidth();
  const margin = 12;
  const rightX = W - margin;
  // Branded letterhead (shared module): logo + company block + gold rule.
  // Returns the y where body content starts — never overlapping the header.
  let y = drawLetterhead(doc, fontName, { margin, top: 14 });

  // Title & receipt number — no hashtag, no overlap with golden border.
  // Plain-text settlement label directly under the title (no stamp graphic).
  const label = data.label ?? settlementLabel(data.outstandingBalance ?? data.soldPrice - data.amountPaid);
  doc.setFont(fontName, "bold");
  doc.setFontSize(22);
  doc.setTextColor(22, 40, 31);
  doc.text("RECEIPT", margin, y);
  doc.setFontSize(9);
  doc.setTextColor(107, 102, 86);
  doc.text(label, margin, y + 5);
  doc.setFontSize(8);
  doc.setFont(fontName, "normal");
  doc.text(`RECEIPT: ${data.ref}`, rightX, y - 6, { align: "right" });
  doc.text(`ISSUED DATE: ${data.issuedDate}`, rightX, y - 1, { align: "right" });
  if (data.accountRef) {
    doc.text(`ACCOUNT: ${data.accountRef}`, rightX, y + 4, { align: "right" });
  }
  if (data.replacesRef) {
    doc.setFontSize(7);
    doc.setTextColor(150, 90, 40);
    doc.text(`Replaces ${data.replacesRef}`, rightX, y + 8.5, { align: "right" });
    doc.setTextColor(107, 102, 86);
  }
  y += 10;

  // Issued to block + Amount panel
  const leftW = 110;
  const panelW = W - margin * 2 - leftW - 6;
  const panelX = margin + leftW + 6;
  const blockTop = y;

  // Issued to — ONLY customer information (no property description, no icon)
  doc.setFont(fontName, "bold");
  doc.setFontSize(7);
  doc.setTextColor(107, 102, 86);
  doc.text("ISSUED TO", margin, y);
  y += 6;
  const displayName = formatDisplayName(data.clientName);
  doc.setFont(fontName, "bold");
  doc.setFontSize(10);
  doc.setTextColor(22, 40, 31);
  // Wrap to the left column so long names stay on the page (splitTextToSize
  // breaks unbroken strings by measured width, advancing y per line).
  const nameLines = doc.splitTextToSize(displayName, leftW - 2);
  doc.text(nameLines, margin, y);
  y += 6 + (nameLines.length - 1) * 4;
  doc.setFont(fontName, "normal");
  doc.setFontSize(7);
  doc.setTextColor(80, 80, 80);
  // Only phone/email under Issued To — do NOT render property description here
  for (const contact of [data.clientPhone, data.clientEmail].filter(Boolean) as string[]) {
    const contactLines = doc.splitTextToSize(contact, leftW - 2);
    doc.text(contactLines, margin, y);
    y += 3.5 * contactLines.length;
  }
  // Provide small breathing room
  y += 2;

  // Amount panel (right) — fill with --accent-gold #C79A46
  const amountPanelTop = blockTop - 2;
  const amountPanelH = 36;
  doc.setFillColor(199, 154, 70);
  (doc as any).roundedRect(panelX, amountPanelTop, panelW, amountPanelH, 2, 2, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont(fontName, "bold");
  doc.setFontSize(7);
  doc.text("AMOUNT", panelX + 4, amountPanelTop + 7);
  doc.setFontSize(16);
  doc.text(formatNaira(data.amountPaid), panelX + 4, amountPanelTop + 16);
  doc.setFont(fontName, "normal");
  doc.setFontSize(7);
  doc.text(`SOLD PRICE: ${formatNaira(data.soldPrice)}`, panelX + 4, amountPanelTop + 22);
  if (typeof data.discount === "number" && data.discount > 0) {
    doc.text(`DISCOUNTS: ${formatNaira(data.discount)}`, panelX + 4, amountPanelTop + 27);
  }

  y = Math.max(y + 4, amountPanelTop + amountPanelH + 8);

  // Property table — MUST be Property | Unit Price | Plot Qty | Amount Due (spec 13)
  // Extend ReceiptData to carry unitPrice/plotQuantity if available (fallback to data)
  const unitPriceVal = (data as any).unitPrice ?? data.soldPrice;
  const plotQtyVal = (data as any).plotQuantity ?? 1;
  const interestVal = data.interestAmount ?? 0;
  const subtotalVal = unitPriceVal * plotQtyVal;
  // Amount Due is the full payable for the plot: subtotal + one-time interest,
  // so the table reconciles with the "Total price" line (7,500,000 + 375,000).
  const amountDueVal = subtotalVal + interestVal;
  const propTableX = margin;
  const propColW = [(W - margin * 2) * 0.42, (W - margin * 2) * 0.22, (W - margin * 2) * 0.14, (W - margin * 2) * 0.22];
  const propRightX = propTableX + W - margin * 2 - 2;
  doc.setFillColor(22, 40, 31);
  doc.rect(propTableX, y, W - margin * 2, 7, "F");
  doc.setTextColor(212, 179, 104);
  doc.setFont(fontName, "bold");
  doc.setFontSize(7);
  const propHeaders = ["Property", "Unit Price", "Plot Qty", "Amount Due"];
  let pcx = propTableX + 2;
  for (let i = 0; i < propHeaders.length; i++) {
    const align = i >= 1 ? "right" : "left";
    const tx = i === 0 ? pcx : i === 3 ? propRightX : propTableX + propColW.slice(0, i).reduce((a, b) => a + b, 0) + 2;
    // For Unit Price, Plot Qty, Amount Due we right-align
    const isRight = i > 0;
    doc.text(propHeaders[i], isRight ? (i === 3 ? propRightX : propTableX + propColW.slice(0, i).reduce((a, b) => a + b, 0) + propColW[i] - 2) : pcx, y + 4.5, { align: isRight ? "right" : "left" });
  }
  y += 7;
  const propRowH = interestVal > 0 ? 12 : 7;
  doc.setFillColor(247, 242, 231);
  doc.rect(propTableX, y, W - margin * 2, propRowH, "F");
  doc.setDrawColor(228, 220, 199);
  doc.rect(propTableX, y, W - margin * 2, propRowH, "S");
  doc.setTextColor(22, 40, 31);
  doc.setFont(fontName, "normal");
  doc.setFontSize(7);
  // Draw vertical lines
  let pvx = propTableX;
  for (let i = 0; i < propColW.length - 1; i++) {
    pvx += propColW[i];
    doc.line(pvx, y, pvx, y + propRowH);
  }
  // Fixed row: truncate as an explicit last resort, with an ellipsis so
  // the cut is visible rather than silently clipped by the cell border.
  const estateCell = data.estateName.length > 32 ? `${data.estateName.substring(0, 31)}…` : data.estateName;
  doc.text(estateCell, propTableX + 2, y + 4.5);
  doc.text(formatNaira(unitPriceVal), propTableX + propColW[0] + propColW[1] - 2, y + 4.5, { align: "right" });
  doc.text(String(plotQtyVal), propTableX + propColW[0] + propColW[1] + propColW[2] - 2, y + 4.5, { align: "right" });
  doc.text(formatNaira(amountDueVal), propRightX, y + 4.5, { align: "right" });
  if (interestVal > 0) {
    // One-time plan interest, shown inside the table so the figures reconcile.
    doc.setDrawColor(228, 220, 199);
    doc.line(propTableX, y + 7, propTableX + W - margin * 2, y + 7);
    doc.setTextColor(80, 80, 80);
    doc.text("Interest", propTableX + 2, y + 10.5);
    doc.text(formatNaira(interestVal), propRightX, y + 10.5, { align: "right" });
  }
  y += propRowH + 5;

  // Payment Details section (spec 14) — show plan, interest, totals if available via extended data
  const ext: any = data as any;
  if (ext.paymentPlanName || ext.interestAmount !== undefined || ext.totalPayable !== undefined) {
    doc.setFont(fontName, "bold");
    doc.setFontSize(7);
    doc.setTextColor(22, 40, 31);
    doc.text("PAYMENT DETAILS", margin, y);
    y += 4;
    doc.setFont(fontName, "normal");
    doc.setFontSize(7);
    doc.setTextColor(80, 80, 80);
    const details: [string, string][] = [];
    // Same amounts layout and wording as the admin receipt page and the
    // client receipt (This payment → Total price → Interest → Paid to date →
    // Balance remaining, Discount only when > 0).
    for (const row of receiptAmountsRows({
      thisPayment: data.amountPaid,
      totalPrice: ext.totalPayable ?? data.soldPrice,
      interestAmount: ext.interestAmount ?? null,
      paidToDate: ext.totalPaidAfter ?? data.amountPaid,
      balanceRemaining: ext.outstandingBalance ?? data.soldPrice - data.amountPaid,
      discount: data.discount ?? 0,
    })) {
      details.push([`${row.label}:`, typeof row.value === "number" ? formatNaira(row.value) : row.value]);
    }
    if (ext.paymentPlanName) details.push(["Payment Plan:", ext.paymentPlanName]);
    if (ext.previouslyPaid !== undefined) details.push(["Previously Paid:", formatNaira(ext.previouslyPaid)]);
    if (data.paymentDate) details.push(["Payment Date:", data.paymentDate]);
    if (data.paymentMethodLabel) details.push(["Method:", data.paymentMethodLabel]);
    if (data.bankReference) details.push(["Bank Ref:", data.bankReference]);
    for (const [label, val] of details) {
      doc.setFont(fontName, "bold");
      doc.text(label, margin, y);
      doc.setFont(fontName, "normal");
      // Wrap long values (plan names, refs) inside the remaining line width.
      const valLines = doc.splitTextToSize(val, W - margin * 2 - 38);
      doc.text(valLines, margin + 38, y);
      y += 3.5 * valLines.length;
    }
    y += 2;
  }

  // Settlement sentence (only when the plan is fully paid): client-facing,
  // derived from settlementCopy — never a staff-only note.
  if (ext.settlementNote) {
    doc.setFont(fontName, "bold");
    doc.setFontSize(7);
    doc.setTextColor(22, 40, 31);
    const noteLines = doc.splitTextToSize(ext.settlementNote, W - margin * 2);
    doc.text(noteLines, margin, y);
    y += 3.5 * noteLines.length + 3;
  }

  // Payment history table: every confirmed payment up to and including this
  // one, each with its receipt ref and the running balance after it.
  const hist: { date: string; method: string; amount: number; receipt: string; balance: number; current: boolean }[] =
    data.history && data.history.length > 0
      ? data.history.map((h) => ({ date: h.date, method: h.method, amount: h.amount, receipt: h.receiptRef ?? "-", balance: h.runningBalance, current: h.isCurrent }))
      : data.payments.map((r) => ({ date: r.date, method: r.method, amount: r.amount, receipt: data.ref, balance: data.soldPrice - r.amount, current: true }));
  const colW = [(W - margin * 2) * 0.07, (W - margin * 2) * 0.20, (W - margin * 2) * 0.20, (W - margin * 2) * 0.19, (W - margin * 2) * 0.17, (W - margin * 2) * 0.17];
  const tableX = margin;
  doc.setFillColor(22, 40, 31);
  doc.rect(tableX, y, W - margin * 2, 7, "F");
  doc.setTextColor(212, 179, 104);
  doc.setFont(fontName, "bold");
  doc.setFontSize(7);
  const headers = ["#", "Payment Date", "Method", "Receipt", "Amount (₦)", "Balance (₦)"];
  const colX = [tableX + 2];
  for (let i = 1; i < colW.length; i++) colX.push(colX[i - 1] + colW[i - 1]);
  for (let i = 0; i < headers.length; i++) {
    const right = i >= 4;
    doc.text(headers[i], right ? colX[i] + colW[i] - 2 : colX[i], y + 4.5, { align: right ? "right" : "left" });
  }
  y += 7;
  doc.setTextColor(22, 40, 31);
  doc.setFont(fontName, "normal");
  doc.setFontSize(7);
  const cellFit = (text: string, maxW: number) =>
    doc.getTextWidth(text) > maxW
      ? `${text.substring(0, Math.max(0, Math.floor((text.length * maxW) / doc.getTextWidth(text)) - 1))}…`
      : text;
  for (let i = 0; i < hist.length; i++) {
    const r = hist[i];
    const rowY = y + 4;
    if (i % 2 === 1) {
      doc.setFillColor(247, 242, 231);
      doc.rect(tableX, y, W - margin * 2, 7, "F");
    }
    doc.setDrawColor(228, 220, 199);
    doc.rect(tableX, y, W - margin * 2, 7, "S");
    let vx = tableX;
    for (let c = 0; c < colW.length - 1; c++) {
      vx += colW[c];
      doc.line(vx, y, vx, y + 7);
    }
    if (r.current) {
      doc.setFont(fontName, "bold");
    }
    doc.text(String(i + 1), colX[0], rowY);
    doc.text(r.date, colX[1], rowY);
    doc.text(cellFit(r.method, colW[2] - 4), colX[2], rowY);
    doc.setFontSize(6);
    doc.text(cellFit(r.receipt, colW[3] - 4), colX[3], rowY);
    doc.setFontSize(7);
    doc.text(formatNaira(r.amount), colX[4] + colW[4] - 2, rowY, { align: "right" });
    doc.text(formatNaira(r.balance), colX[5] + colW[5] - 2, rowY, { align: "right" });
    doc.setFont(fontName, "normal");
    y += 7;
  }
  const paidToDateVal = hist.length > 0 ? (data as any).totalPaidAfter ?? hist.reduce((s, r) => s + r.amount, 0) : data.amountPaid;
  doc.setFillColor(22, 40, 31);
  doc.rect(tableX, y, W - margin * 2, 7, "F");
  doc.setTextColor(212, 179, 104);
  doc.setFont(fontName, "bold");
  doc.text("Total paid to date", tableX + 2, y + 4.5);
  doc.text(formatNaira(paidToDateVal), tableX + W - margin * 2 - 2, y + 4.5, { align: "right" });
  y += 10;

  // Amount in words
  doc.setTextColor(80, 80, 80);
  doc.setFont(fontName, "normal");
  doc.setFontSize(7);
  doc.text("Amount in words:", margin, y);
  y += 4;
  doc.setFont(fontName, "bold");
  doc.setTextColor(22, 40, 31);
  doc.setFontSize(8);
  const words = amountToWords(data.amountPaid);
  const wordLines = doc.splitTextToSize(words, W - margin * 2);
  doc.text(wordLines, margin, y);
  y += wordLines.length * 4 + 6;

  // Authorization block: the real company stamp + signature in one image
  // (the owner's asset — the one allowed stamp; no code-drawn stamp or
  // watermark anywhere). The stamp carries its own Sign/Date lines, so no
  // separate signature line or caption. ~40mm wide, aspect preserved.
  const sigTop = y;
  const sigCenterX = W / 2 - 30;

  doc.setFont(fontName, "bold");
  doc.setFontSize(7);
  doc.setTextColor(22, 40, 31);
  doc.text("AUTHORIZED BY BELGROVE", sigCenterX, sigTop + 4);
  // Verified stamp only: a missing/unreadable asset throws (loud,
  // recoverable PDF failure) — an unstamped receipt must never go out.
  const sigB64 = loadSignatureBase64();
  const stampW = 40;
  const stampH = (stampW * 1149) / 1088;
  try {
    doc.addImage(sigB64, "PNG", sigCenterX, sigTop + 6, stampW, stampH);
  } catch (e) {
    throw new Error(`Receipt stamp embed failed: ${e instanceof Error ? e.message : e}`);
  }
  doc.setFont(fontName, "normal");
  doc.setFontSize(6);
  doc.setTextColor(107, 102, 86);
  doc.text(`Date: ${data.issuedDate}`, sigCenterX, sigTop + 6 + stampH + 4);

  y = sigTop + 6 + stampH + 10;

  // Footer
  doc.setFont(fontName, "bold");
  doc.setFontSize(9);
  doc.setTextColor(22, 40, 31);
  doc.text("THANK YOU!", margin, y);
  y += 4;
  doc.setFont(fontName, "normal");
  doc.setFontSize(7);
  doc.setTextColor(107, 102, 86);
  doc.text("PLEASURE DOING BUSINESS WITH YOU: certainty, not just a deed.", margin, y);
  y += 6;
  doc.setFontSize(6);
  const disclaimer =
    "This receipt acknowledges payment as received and reconciled by Belgrove Homes accounts. Property allocation is subject to completion of the agreed payment plan and verification of funds. Keep this receipt safely; present it for allocation and documentation.";
  const qrSize = 24;
  const discLines = doc.splitTextToSize(disclaimer, W - margin * 2 - (qrSize + 8));
  doc.text(discLines, margin, y);
  if (data.qrDataUrl) {
    try {
      const qrX = W - margin - qrSize;
      const qrY = y - 6;
      // Solid white backing so the QR quiet zone survives printing on the
      // cream footer area and scanners see full contrast.
      doc.setFillColor(255, 255, 255);
      doc.rect(qrX - 1.5, qrY - 1.5, qrSize + 3, qrSize + 3, "F");
      doc.addImage(data.qrDataUrl, "PNG", qrX, qrY, qrSize, qrSize);
      doc.setFontSize(5);
      doc.setTextColor(107, 102, 86);
      doc.text("Scan to verify", qrX + qrSize / 2, qrY + qrSize + 3, { align: "center" });
    } catch (e) {
      console.error("Receipt PDF: QR embed failed, continuing without it", e);
    }
  }

  const out = doc.output("arraybuffer");
  return Buffer.from(out);
}
