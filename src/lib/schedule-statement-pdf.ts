import {
  renderScheduleStatementHtml,
  type ScheduleStatementHtmlAssets,
} from "../../docs/reference/statement-template/schedule-statement-html.mjs";
import { buildStatementAssets, statementFmt } from "@/lib/statement-pdf";
import { launchStatementBrowser } from "@/lib/statement-chromium";
import type { ScheduleStatementModel } from "@/lib/schedule-statement-model";

// The single code path that produces a SCHEDULE STATEMENT PDF. Same visual
// identity, formatters and Chromium pipeline as the ledger statement — only the
// template (one row per installment, with status) differs, so the two client
// documents agree on money and dates and can never drift apart.

export async function buildScheduleStatementAssets(opts: {
  token?: string | null;
  stamp?: boolean;
}): Promise<ScheduleStatementHtmlAssets> {
  return buildStatementAssets(opts);
}

export async function renderScheduleStatementHtmlForModel(
  model: ScheduleStatementModel,
  assets: ScheduleStatementHtmlAssets
): Promise<string> {
  return renderScheduleStatementHtml(model, assets, statementFmt);
}

export async function renderScheduleStatementPdf(
  model: ScheduleStatementModel,
  opts: { token?: string | null } = {}
): Promise<Buffer> {
  const draft = model.isDraft;
  const assets = await buildScheduleStatementAssets({ token: opts.token, stamp: !draft });
  const html = await renderScheduleStatementHtmlForModel(model, assets);
  const browser = await launchStatementBrowser();
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.resourceType() === "document" || req.url().startsWith("data:")) {
        void req.continue();
      } else {
        void req.abort();
      }
    });
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
