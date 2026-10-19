import { lagosDayKey } from "@/lib/time";

// Contract date: the sale date a transaction's charges are effective on.
//
// Lives in its own module (not statement-model) so the statement, the company
// ledger and the contract-date routes can all share one rule without an import
// cycle. The rule, in words:
//   1. An explicit `contractDate` wins — unless `detectCreationArtifact` is on
//      and it sits on the SAME Lagos day as `createdAt`, which means nobody
//      actually chose it (it was defaulted at creation) and the date on the
//      sheet is an artifact, not a recorded sale date.
//   2. Otherwise the earliest candidate payment date dates the sale, so a
//      backdated first payment doesn't sort the charge last and drive balances
//      negative. "Candidate" = CONFIRMED, plus PENDING_VERIFICATION when
//      `includePending` (a pending payment never prints, it only dates the
//      opening charge).
//   3. Otherwise creation.
// Callers decide whether an assumed date is printed: the client statement
// hides it, the company ledger reports it as a warning.

export type ContractDateSource = "explicit" | "earliest-confirmed-payment" | "creation";

export type ResolvedContractDate = {
  date: Date;
  assumed: boolean;
  source: ContractDateSource;
};

export type ContractDatePayment = { status: string; paymentDate: Date | string };

export type ResolveContractDateOptions = {
  includePending?: boolean;
  detectCreationArtifact?: boolean;
};

export function resolveContractDate(
  txn: { contractDate: Date | string | null; createdAt: Date | string },
  payments: ContractDatePayment[],
  opts: ResolveContractDateOptions = {}
): ResolvedContractDate {
  const includePending = opts.includePending ?? true;
  const detectCreationArtifact = opts.detectCreationArtifact ?? false;
  const createdAt = new Date(txn.createdAt);

  if (txn.contractDate) {
    const explicit = new Date(txn.contractDate);
    const artifact = detectCreationArtifact && lagosDayKey(explicit) === lagosDayKey(createdAt);
    if (!artifact) {
      return { date: explicit, assumed: false, source: "explicit" };
    }
  }

  const dated = payments.filter(
    (p) => p.status === "CONFIRMED" || (includePending && p.status === "PENDING_VERIFICATION")
  );
  if (dated.length > 0) {
    return {
      date: new Date(Math.min(...dated.map((p) => new Date(p.paymentDate).getTime()))),
      assumed: true,
      source: "earliest-confirmed-payment",
    };
  }

  return { date: createdAt, assumed: true, source: "creation" };
}
