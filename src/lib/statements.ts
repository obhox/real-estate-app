import { createHash } from "node:crypto";
import { getAppUrl, generateReceiptAccessToken } from "./app-url";
import { generateUniqueStatementNumber } from "./ref";
import { getEffectiveEntries, hashLedgerEntries, type TxClient } from "./finance/ledger";
import { buildStatementModel, type StatementModelDb } from "./statement-model";
import { renderStatementPdf } from "./statement-pdf";
import { buildScheduleStatementModel, type ScheduleStatementModelDb } from "./schedule-statement-model";
import { renderScheduleStatementPdf } from "./schedule-statement-pdf";
import { logLedgerError } from "./finance/ledger";

// Single statement lifecycle: preview renders on the fly (never stored);
// issue stores an immutable PDF + number + token (deduped by ledger hash);
// email sends only through the explicit per-statement endpoint.
// Generating or downloading NEVER emails — audit the call sites if in doubt.
//
// Every issued PDF comes from the one entry point, renderStatementPdf
// (supplied HTML template + headless Chromium). Stored bytes are served for
// downloads and attachments — never regenerated.

// PDFs stay as private bytes on the row (never under public/): on ephemeral
// serverless filesystems a storage-key backend would be less durable, not
// more. asOfDate/layoutVersion/pdfSha256 are recorded alongside.

export type IssueResult = {
  statement: { id: string; number: string; token: string; closingBalance: number; asAt: Date };
  created: boolean;
};

export class StatementDataError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Statement data check failed: ${problems.join("; ")}`);
    this.name = "StatementDataError";
    this.problems = problems;
  }
}

export function statementVerifyUrl(token: string): string {
  return `${getAppUrl()}/s/${token}`;
}

export function scheduleStatementVerifyUrl(token: string): string {
  return `${getAppUrl()}/ss/${token}`;
}

export async function issueStatement(
  db: StatementModelDb & {
    statement: {
      findFirst(args: unknown): Promise<{ id: string; number: string; token: string; closingBalance: number; asAt: Date } | null>;
      create(args: unknown): Promise<{ id: string; asAt: Date }>;
    };
    auditEvent: { create(args: unknown): Promise<unknown> };
    $transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  },
  opts: {
    transactionId: string;
    actorId?: string | null;
    actorName?: string | null;
    asOf?: Date;
    warnAcknowledged?: boolean;
  }
): Promise<IssueResult> {
  // Phase 1 — reads + render outside any transaction (DB work and Chromium
  // must never share a transaction: a slow render must not hold one open).
  const txn = await db.transaction.findUnique({
    where: { id: opts.transactionId },
  });
  if (!txn) throw new Error("Transaction not found");
  const entries = await getEffectiveEntries(db, opts.transactionId);
  const hash = hashLedgerEntries(entries);
  const already = await db.statement.findFirst({
    where: { transactionId: opts.transactionId, kind: "LEDGER", ledgerHash: hash },
    orderBy: { createdAt: "desc" },
  });
  if (already) {
    return {
      statement: { id: already.id, number: already.number, token: already.token, closingBalance: already.closingBalance, asAt: already.asAt },
      created: false,
    };
  }
  const number = await generateUniqueStatementNumber();
  const token = generateReceiptAccessToken();
  const asOf = opts.asOf ?? new Date();
  const model = await buildStatementModel(db, {
    transactionId: opts.transactionId,
    asOf,
    draft: false,
    number,
  });
  // Invariant failures block issuing everywhere (Generate route pre-checks
  // and surfaces the same list; this guard protects every other issuer too).
  if (model.dataCheckErrors.length > 0) {
    logLedgerError(`statement ${number}: data check failed`, model.dataCheckErrors);
    throw new StatementDataError(model.dataCheckErrors);
  }
  let pdf: Buffer;
  try {
    pdf = await renderStatementPdf(model, { token });
  } catch (e) {
    logLedgerError(`statement ${number}: render failed`, e);
    throw e;
  }
  // Phase 2 — DB writes only, in one short transaction.
  return db.$transaction(async (tx) => {
    const raced = await tx.statement.findFirst({
      where: { transactionId: opts.transactionId, kind: "LEDGER", ledgerHash: hash },
      orderBy: { createdAt: "desc" },
    });
    if (raced) {
      return {
        statement: { id: raced.id, number: raced.number, token: raced.token, closingBalance: raced.closingBalance, asAt: raced.asAt },
        created: false,
      };
    }
    const created = await tx.statement.create({
      data: {
        number,
        transactionId: txn.id,
        token,
        pdfData: new Uint8Array(pdf),
        closingBalance: model.closing.balance,
        ledgerHash: hash,
        asOfDate: asOf,
        layoutVersion: model.layoutVersion,
        pdfSha256: createHash("sha256").update(pdf).digest("hex"),
        createdById: opts.actorId ?? null,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: opts.actorId ?? null,
        actorName: opts.actorName ?? "System",
        action: "statement.generate",
        entityType: "statement",
        entityId: created.id,
        before: { ledgerHash: null },
        after: {
          number,
          closingBalance: model.closing.balance,
          entries: entries.length,
          layoutVersion: model.layoutVersion,
          warnings: model.warnings,
          warnAcknowledged: opts.warnAcknowledged ?? false,
        },
      },
    });
    return {
      statement: { id: created.id, number, token, closingBalance: model.closing.balance, asAt: created.asAt },
      created: true,
    };
  });
}

// --- Schedule Statement (client-facing) ------------------------------------
//
// Same lifecycle as the ledger Statement of Account above — preview renders on
// the fly, issue stores an immutable PDF + number + token, deduped by a hash of
// the document state — but a different document (one row per installment, with
// status) and a different public path (/ss/[token]). The dedupe hash covers the
// installment rows and the received amounts, so re-issuing after a new confirmed
// payment creates a new statement while a repeat with no change returns the
// existing one. Stored bytes are served for downloads/attachments, never
// regenerated.

export function hashScheduleModel(model: {
  rows: { dueDate: string; scheduled: number; received: number; status: string }[];
  totals: { scheduled: number; received: number; outstanding: number; credit: number };
  layoutVersion: string;
}): string {
  const rows = model.rows
    .map((r) => `${r.dueDate}:${r.scheduled}:${r.received}:${r.status}`)
    .join("|");
  const t = model.totals;
  return createHash("sha256")
    .update(`${model.layoutVersion}\n${rows}\n${t.scheduled}:${t.received}:${t.outstanding}:${t.credit}`)
    .digest("hex");
}

export async function issueScheduleStatement(
  db: ScheduleStatementModelDb & {
    statement: {
      findFirst(args: unknown): Promise<{ id: string; number: string; token: string; closingBalance: number; asAt: Date } | null>;
      create(args: unknown): Promise<{ id: string; asAt: Date }>;
    };
    auditEvent: { create(args: unknown): Promise<unknown> };
    $transaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
  },
  opts: {
    transactionId: string;
    actorId?: string | null;
    actorName?: string | null;
    asOf?: Date;
  }
): Promise<IssueResult> {
  const txn = await db.transaction.findUnique({ where: { id: opts.transactionId } });
  if (!txn) throw new Error("Transaction not found");

  const asOf = opts.asOf ?? new Date();
  const model = await buildScheduleStatementModel(db, {
    transactionId: opts.transactionId,
    asOf,
    draft: false,
  });
  if (model.dataCheckErrors.length > 0) {
    logLedgerError(`schedule statement for ${txn.ref}: data check failed`, model.dataCheckErrors);
    throw new StatementDataError(model.dataCheckErrors);
  }
  const hash = hashScheduleModel(model);
  const already = await db.statement.findFirst({
    where: { transactionId: opts.transactionId, kind: "SCHEDULE", ledgerHash: hash },
    orderBy: { createdAt: "desc" },
  });
  if (already) {
    return {
      statement: { id: already.id, number: already.number, token: already.token, closingBalance: already.closingBalance, asAt: already.asAt },
      created: false,
    };
  }
  const number = await generateUniqueStatementNumber();
  const token = generateReceiptAccessToken();
  let pdf: Buffer;
  try {
    pdf = await renderScheduleStatementPdf(model, { token });
  } catch (e) {
    logLedgerError(`schedule statement ${number}: render failed`, e);
    throw e;
  }
  return db.$transaction(async (tx) => {
    const raced = await tx.statement.findFirst({
      where: { transactionId: opts.transactionId, kind: "SCHEDULE", ledgerHash: hash },
      orderBy: { createdAt: "desc" },
    });
    if (raced) {
      return {
        statement: { id: raced.id, number: raced.number, token: raced.token, closingBalance: raced.closingBalance, asAt: raced.asAt },
        created: false,
      };
    }
    const created = await tx.statement.create({
      data: {
        number,
        transactionId: txn.id,
        token,
        kind: "SCHEDULE",
        pdfData: new Uint8Array(pdf),
        closingBalance: model.totals.outstanding,
        ledgerHash: hash,
        asOfDate: asOf,
        layoutVersion: model.layoutVersion,
        pdfSha256: createHash("sha256").update(pdf).digest("hex"),
        createdById: opts.actorId ?? null,
      },
    });
    await tx.auditEvent.create({
      data: {
        actorId: opts.actorId ?? null,
        actorName: opts.actorName ?? "System",
        action: "schedule_statement.generate",
        entityType: "statement",
        entityId: created.id,
        before: { ledgerHash: null },
        after: {
          number,
          outstanding: model.totals.outstanding,
          rows: model.rows.length,
          layoutVersion: model.layoutVersion,
        },
      },
    });
    return {
      statement: { id: created.id, number, token, closingBalance: model.totals.outstanding, asAt: created.asAt },
      created: true,
    };
  });
}
