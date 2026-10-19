import { renderCompanyLedgerHtml } from "../../docs/reference/company-ledger-template/company-ledger-html.mjs";
import type { CompanyLedgerHtmlAssets } from "../../docs/reference/company-ledger-template/company-ledger-html.mjs";
import { formatCellNaira, formatSignedNaira } from "@/lib/currency";
import { brandLogo } from "@/lib/documents/brand";
import { statementFontFaceCss } from "@/lib/statement-assets";
import { launchStatementBrowser } from "@/lib/statement-chromium";
import type { CompanyLedgerModel } from "@/lib/company-ledger";

// The single code path that produces a Company Sales Ledger PDF. HTML comes
// from the supplied template module, printed by headless Chromium (A4
// landscape, backgrounds on, CSS page size) — the same browser launcher,
// embedded fonts and money formatters as the client statement, so the two can
// never render differently. No hand-positioned text, no second totals pass.

// Shared formatters, identical to the statement's: money for money columns and
// summary (negative as -₦N, zero ₦0), cell for the two ledger amount columns
// (bare numbers, "-" when empty).
export const companyLedgerFmt = {
  money: (n: number): string => formatSignedNaira(n),
  cell: (n: number | undefined): string => formatCellNaira(n),
};

export function buildCompanyLedgerAssets(): CompanyLedgerHtmlAssets {
  return {
    logoSrc: brandLogo(),
    fontFamily: "'Noto Sans'",
    fontFaceCss: statementFontFaceCss(),
  };
}

export function renderCompanyLedgerHtmlForModel(
  model: CompanyLedgerModel,
  assets: CompanyLedgerHtmlAssets
): string {
  return renderCompanyLedgerHtml(model, assets, companyLedgerFmt);
}

// Full pipeline: model → HTML → landscape A4 PDF bytes.
export async function renderCompanyLedgerPdf(model: CompanyLedgerModel): Promise<Buffer> {
  const assets = buildCompanyLedgerAssets();
  const html = renderCompanyLedgerHtmlForModel(model, assets);
  const browser = await launchStatementBrowser();
  try {
    const page = await browser.newPage();
    // No network access during render: every image and font is a data URL.
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.resourceType() === "document" || req.url().startsWith("data:")) {
        void req.continue();
      } else {
        void req.abort();
      }
    });
    await page.setContent(html, { waitUntil: "load" });
    const pdf = await page.pdf({ format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
