import { describe, it, expect, beforeAll } from "vitest";
import { PDFParse } from "pdf-parse";
import { renderScheduleStatementHtml } from "../../../docs/reference/statement-template/schedule-statement-html.mjs";
import { renderScheduleStatementHtmlForModel, renderScheduleStatementPdf } from "../schedule-statement-pdf";
import { resolveChromeExecutable } from "../statement-chromium";
import type { ScheduleStatementModel } from "../schedule-statement-model";

function model(over: Partial<ScheduleStatementModel> = {}): ScheduleStatementModel {
  return {
    isDraft: true,
    accountRef: "TXN-2026-19362",
    generatedOn: "17-10-2026",
    asOf: "17-10-2026",
    company: {
      name: "BELGROVE HOMES AND PROPERTIES LIMITED",
      addressLine: "Suite 25, Lebrex Plaza",
      website: "www.belgrovehomes.com",
      email: "info@belgrovehomes.com",
      phone: "+234 8103760063",
    },
    client: { name: "Valentine Nzube Onweluzo", email: "v@x.com" },
    property: { estate: "Sunrise Estate", unitType: "Duplex", sku: "SUN-P1-500SQM", plots: 1 },
    rows: [
      { dueDate: "14-10-2026", label: "Initial deposit", scheduled: 3_937_500, received: 3_937_500, status: "Paid", settled: true },
      { dueDate: "14-12-2026", label: "Month 1 payment", scheduled: 656_250, received: 656_250, status: "Paid", settled: true },
      { dueDate: "14-01-2027", label: "Month 2 payment", scheduled: 656_250, received: 656_250, status: "Paid", settled: true },
      { dueDate: "14-02-2027", label: "Month 3 payment", scheduled: 656_250, received: 656_250, status: "Paid", settled: true },
      { dueDate: "14-03-2027", label: "Month 4 payment", scheduled: 656_250, received: 31_250, status: "Part paid, ₦625,000 remaining", settled: false },
      { dueDate: "14-04-2027", label: "Month 5 payment", scheduled: 656_250, received: 0, status: "Not yet due, ₦656,250 remaining", settled: false },
      { dueDate: "14-05-2027", label: "Month 6 payment", scheduled: 656_250, received: 0, status: "Not yet due, ₦656,250 remaining", settled: false },
    ],
    totals: { scheduled: 7_875_000, received: 5_937_500, outstanding: 1_937_500, credit: 0 },
    nextDue: { dueDate: "14-03-2027", label: "Month 4 payment", amount: 625_000 },
    fullyPaid: false,
    settledOn: null,
    layoutVersion: "sched-v1",
    dataCheckErrors: [],
    ...over,
  };
}

const ASSETS = { logoSrc: "data:image/png;base64,xx", fontFamily: "'Noto Sans'", fontFaceCss: "" };

describe("schedule statement template (no browser needed)", () => {
  it("marks a draft and never a number, and drops the marker when issued", async () => {
    const draft = await renderScheduleStatementHtmlForModel(model(), ASSETS);
    expect(draft).toContain("sched-v1 draft");
    expect(draft).toContain("DRAFT, NOT ISSUED");
    expect(draft).not.toContain("STM-2026-00001");

    const issued = await renderScheduleStatementHtmlForModel(
      { ...model(), isDraft: false, number: "STM-2026-00001" },
      ASSETS
    );
    expect(issued).not.toContain("sched-v1 draft");
    expect(issued).not.toContain("DRAFT, NOT ISSUED");
    expect(issued).toContain("STM-2026-00001");
  });

  it("renders one row per installment with its status and money", async () => {
    const html = await renderScheduleStatementHtmlForModel(model(), ASSETS);
    expect(html).toContain("SCHEDULE STATEMENT");
    expect(html).toContain("Month 4 payment");
    expect(html).toContain("Part paid, ₦625,000 remaining");
    expect(html).toContain("TOTAL SCHEDULED");
    // Uses the supplied template module (single visual source).
    expect(renderScheduleStatementHtml).toBeDefined();
  });
});

describe("schedule statement Chromium render", () => {
  let chromeOk = false;
  beforeAll(async () => {
    try {
      await resolveChromeExecutable();
      chromeOk = true;
    } catch {
      console.warn("schedule-statement-pdf render tests skipped: no Chromium available");
    }
  });

  it("renders a draft PDF with the heading, a row and the naira sign", async () => {
    if (!chromeOk) return;
    const pdf = await renderScheduleStatementPdf(model(), { token: null });
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const parser = new PDFParse({ data: pdf });
    const { text } = await parser.getText();
    await parser.destroy();
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("SCHEDULE STATEMENT");
    expect(flat).toContain("Month 4 payment");
    expect(flat).toContain("₦");
  });
});
