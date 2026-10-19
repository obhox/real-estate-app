# Company Sales Ledger — diagnosis

Read-only audit of the "Company Sales Ledger" export
(`GET /api/admin/transactions/ledger`) and the data it reads. No money record
was written; all inspection was done against a **scratch copy** of production
(`docker` `belgrove-scratch-pg`, `localhost:5545`, DB `scratch_ledger`), restored
from a read-only `pg_dump` of the Neon production database. Nothing on this
machine writes back to production.

The reported artefact is `belgrove-ledger-2026-10-19.pdf`.

---

## 1. What the export is

`src/app/api/admin/transactions/ledger/route.ts` builds the PDF with **jsPDF +
jspdf-autotable** (not the statement HTML→Chromium path), runs its own inline
`prisma` queries, and caps the report at `LEDGER_CAP = 500` transactions. It
does **not** use the shared finance/ledger service, and it reconstructs
balances itself. Columns are:

`Date | TXN Number | Client Name | Property | Ref Number | Debit | Credit | Installment Balance | Company Balance`

## 2. Live data behind the report (scratch copy of production)

**Three transactions** (no `isTest` rows):

| TXN | Client | Contract price | Paid (confirmed) | Stored outstanding | Status | created | contractDate |
|---|---|---|---|---|---|---|---|
| `TXN-2026-89439` | Azubuike Nnamdi Mac Anthony | 5,800,000 | 5,800,000 | 0 | PAID_IN_FULL | 07 Oct | *(null)* |
| `TXN-2026-62831` | Valentine nzube Onweluzo | 18,500,000 | 12,000,000 | 6,500,000 | ACTIVE | 09 Oct | *(null)* |
| `TXN-2026-96894` | SANDRA MBEYI | 5,625,000 | 5,625,000 | 0 | PAID_IN_FULL | 13 Oct | 13 Oct |

**Confirmed payments** (the only ones that count):

| TXN | Payment ref | Amount | Payment date |
|---|---|---|---|
| 62831 | PAY-2026-18756 | 3,000,000 | 09 Aug 2026 |
| 62831 | PAY-2026-87544 | **3,250,000** | 12 Aug 2026 |
| 62831 | PAY-2026-71254 | 3,000,000 | 19 Aug 2026 |
| 62831 | PAY-2026-18810 | **2,750,000** | 24 Sep 2026 |
| 96894 | PAY-2026-58673 | 2,812,000 | 13 Aug 2026 |
| 96894 | PAY-2026-93694 | 1,000,000 | 08 Sep 2026 |
| 96894 | PAY-2026-26635 | 1,000,000 | 25 Sep 2026 |
| 96894 | PAY-2026-33838 | 813,000 | 09 Oct 2026 |
| 89439 | PAY-2026-43298 | 5,800,000 | 07 Oct 2026 |

Cancelled (Sandra): `PAY-2026-59375` 2,812,000, `PAY-2026-43639` 281,200,
`PAY-2026-49865` 1,000,000 — replaced by the confirmed rows above. Nine receipts
(`RCT-2026-*`) exist, all `GENERATED`, none voided.

`CHARGE_BASE` ledger entries are dated at **transaction creation**, not the sale:
`TXN-2026-62831` → 09 Oct, `TXN-2026-96894` → 13 Oct, `TXN-2026-89439` → 07 Oct.

**Totals:** charges 29,925,000 − confirmed payments 23,425,000 = **6,500,000**,
which equals the sum of stored `outstandingBalance` (6,500,000 + 0 + 0). The
live figures already tie; the export's *presentation* is what is broken.

## 3. The reported defects

### 3.1 Sales are dated at entry/creation, not the contract date (third occurrence)

`CHARGE_BASE.effectiveDate` is written at creation. `TXN-2026-62831` (a sale
that took its first payment on **09 Aug**) carries a charge dated **09 Oct**;
`TXN-2026-96894` carries **13 Oct**. This is the fourth financial surface to
show the same artefact (statements, receipts, payment history, now the company
ledger). Root cause is shared: `transactionService.ts:98,246` sets
`contractDate: now` at creation, and nothing re-dates the charge until an admin
correction is made.

### 3.2 "Company Balance" goes negative

Because the creation-dated sale sorts *after* the backdated payments, the
running `Company Balance` collapses through zero and bottoms at
**−16,812,000** before recovering to 6,500,000 — matching the reported PDF. It
is a pure ordering artefact, not a data error.

### 3.3 The two balance columns use different logic

- `Installment Balance` = that transaction's `totalPayable − paid-so-far`
  (a per-account figure).
- `Company Balance` = its own running `opening + debits − credits`.

Two independent calculations in one file, computed on different bases, with no
shared code — so they cannot be reconciled or tested together. (See §5.)

### 3.4 Labels and formatting

- `NGN` instead of `₦`; negatives print as `NGN -3,000,000` instead of `-₦…`.
- Dates print as `08 Sept 2026` (three-letter month, not the shared `dd-mm-yyyy`).
- Client names are not title-cased (`SANDRA MBEYI`, `Valentine nzube Onweluzo`).
- No sale/payment indicator column; sale rows repeat the TXN number in `Ref`.
- `Installment Balance` / `Company Balance` are not self-explanatory.

### 3.5 "Confirmed payments only" may hide whole transactions

The existing filter is applied at *transaction selection* time. A transaction
whose only movements are non-confirmed should still be listed (its sale is
real), but in the current build the filter can drop the transaction entirely,
taking a legitimate sale row with it. The rebuild filters **payment rows only**.

## 4. Transactions reported missing (11 Oct, RCT-2026-15146, ~27.45M overdue)

The user reported an 11 Oct production snapshot with 7 transactions including
three overdue (~NGN 27.45M) and a NGN 300,000 cash receipt `RCT-2026-15146`.

**None of those exist in this database copy.** It contains exactly the three
transactions above, all created 07–13 Oct, no 11-Oct rows, no `RCT-2026-15146`,
no 300,000 cash payment, and no ~27.45M overdue cluster. Either the user is
looking at a different environment/snapshot, or those records were created after
this dump was taken. This audit can neither confirm nor deny them, and the
golden fixture in Part 3 (which assumes them and the corrected Valentine
amounts) will differ from this DB until both the corrections and the additional
records are present. **Report this gap; do not "fix" it here.**

## 5. Balance calculations in the codebase (single-source audit)

Distinct running/outstanding balance computations:

| # | Location | What it computes | Disposition |
|---|---|---|---|
| 1 | `ledger/route.ts` — "Installment Balance" | per-account payable − paid | **removed** (route rewritten) |
| 2 | `ledger/route.ts` — "Company Balance" | running opening + debits − credits | **removed** (route rewritten) |
| 3 | `src/lib/statement.ts` `buildStatementRows` | per-transaction running balance | kept (per-account statement) |
| 4 | `src/lib/statement-model.ts` `buildStatementModel` | per-transaction running balance | kept (document model) |
| 5 | `src/lib/finance/ledger.ts` `getLedgerBalances` | per-transaction outstanding | kept (service) |
| 6 | `src/lib/finance/index.ts` `getTransactionFinancials` | per-transaction outstanding | kept (dashboard source) |
| 7 | `paymentConfirmation.ts` / `paymentService.ts` | incremental stored `outstandingBalance` write | kept (write path) |
| 8 | `Transaction.outstandingBalance` stored column | denormalised cache | kept (reconciled by service) |

The rebuild removes the **two ad-hoc calculations in the ledger route** (#1, #2)
and replaces them with a **single pass** over the shared ordered ledger, so the
company ledger can no longer disagree with the statement or the dashboard. The
company-wide "total owed" is the running sum of the per-account balances — one
calculation, one pass.

## 6. Invariants confirmed on live data

- Sum of `CHARGE_BASE` (29,925,000) − confirmed payments (23,425,000) =
  6,500,000.
- Sum of stored `outstandingBalance` = 6,500,000.
- Each account's own arithmetic is internally consistent.

So the closing `Company Balance` already equals total outstanding; the export
merely displays the journey wrongly.

## 7. Unverifiable / open

- The 11-Oct snapshot records (§4) — not present here.
- The corrected Valentine amounts (3,000,000 / 3,000,000) — this DB still holds
  3,250,000 / 2,750,000. Totals are unaffected (12,000,000 either way); only the
  split shown changes.
- Whether a production host serves statements through the CDN Chromium pack is
  unconfirmed (pre-existing note in `statement-chromium.ts`).

## 8. Rebuild plan (Parts 2–4)

Replace the jsPDF route with the statement HTML→Chromium path (landscape A4):
one `buildCompanyLedgerModel({from?, to?, includeCorrections?})` that reads the
ledger service only, resolves the sale date with a shared
`resolveContractDate` helper (explicit date → earliest **confirmed** payment
date → creation, with the creation-time artefact detected as
`contractDate == createdAt` and treated as unset), orders rows with the shared
`compareLedgerEntries`, and walks **one** running balance that simultaneously
yields each account's balance and the company total. Formatting goes through
`formatNaira`/`formatSignedNaira`, `formatDateDMY`, and `formatDisplayName`.
