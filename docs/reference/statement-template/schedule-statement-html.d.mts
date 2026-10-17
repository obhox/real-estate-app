// Types for schedule-statement-html.mjs (the single visual source of truth for
// the client-facing schedule statement; PDF, panel and routes import one copy).
export type ScheduleStatementHtmlModel = {
  isDraft: boolean;
  layoutVersion: string;
  accountRef: string;
  generatedOn: string;
  asOf: string;
  number?: string;
  company: { name: string; addressLine: string; website: string; email: string; phone: string };
  client: { name: string; phone?: string; email?: string };
  property: { estate: string; unitType: string; sku: string; plots: number };
  rows: {
    dueDate: string;
    label: string;
    scheduled: number;
    received: number;
    status: string;
  }[];
  totals: { scheduled: number; received: number; outstanding: number };
  nextDue: { dueDate: string; label: string; amount: number } | null;
  fullyPaid: boolean;
  settledOn: string | null;
};

export type ScheduleStatementHtmlAssets = {
  logoSrc: string;
  stampSrc?: string;
  qrSvg?: string;
  fontFamily?: string;
  fontFaceCss?: string;
};

export type ScheduleStatementHtmlFmt = {
  money(n: number): string;
  cell(n: number | undefined): string;
};

export function renderScheduleStatementHtml(
  model: ScheduleStatementHtmlModel,
  assets: ScheduleStatementHtmlAssets,
  fmt: ScheduleStatementHtmlFmt
): string;
