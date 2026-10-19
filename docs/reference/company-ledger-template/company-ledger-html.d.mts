// Types for company-ledger-html.mjs (the single visual source of truth for the
// Company Sales Ledger sheet — kept beside the .mjs so the PDF renderer and
// the tests all read one copy, never a duplicate).
export type CompanyLedgerHtmlRow = {
  date: string;
  accountRef: string;
  clientName: string;
  entry: string;
  reference: string;
  debit: number | null;
  credit: number | null;
  accountBalance: number | null;
  totalOwed: number;
  correction: boolean;
  pending: boolean;
  isOpening: boolean;
};

export type CompanyLedgerHtmlModel = {
  layoutVersion: string;
  company: { name: string; addressLine: string; website: string; email: string; phone: string };
  generatedOn: string;
  asOf: string;
  period: { from: string | null; to: string | null };
  confirmedOnly: boolean;
  includeCorrections: boolean;
  accounts: number;
  rowCount: number;
  rows: CompanyLedgerHtmlRow[];
  totals: { debit: number; credit: number; owed: number };
  summary: { totalSales: number; totalReceived: number; totalOwed: number };
  outstandingByAccount: {
    accountRef: string;
    clientName: string;
    contractPrice: number;
    paid: number;
    outstanding: number;
  }[];
  outstandingTotals: { contractPrice: number; paid: number; outstanding: number };
  warnings: string[];
};

export type CompanyLedgerHtmlAssets = {
  logoSrc: string;
  fontFamily?: string;
  fontFaceCss?: string;
};

export type CompanyLedgerHtmlFmt = {
  money(n: number): string;
  cell(n: number | undefined): string;
};

export function renderCompanyLedgerHtml(
  model: CompanyLedgerHtmlModel,
  assets: CompanyLedgerHtmlAssets,
  fmt: CompanyLedgerHtmlFmt
): string;
