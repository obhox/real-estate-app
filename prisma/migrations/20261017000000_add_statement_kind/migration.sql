-- Statement gains a `kind` discriminator so the client-facing Schedule
-- Statement and the staff/internal ledger Statement of Account share one
-- issue/token/serve/email lifecycle without ever sharing a dedupe key.
-- Existing rows are Statement of Account, so they default to 'LEDGER'.

-- AlterTable
ALTER TABLE "Statement" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'LEDGER';

-- CreateIndex
CREATE INDEX "Statement_transactionId_kind_ledgerHash_idx" ON "Statement"("transactionId", "kind", "ledgerHash");
