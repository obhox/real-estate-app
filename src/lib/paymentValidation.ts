import { formatNaira } from "@/lib/currency";

// Shared payment validation — ONE rule set, run on the client (for instant
// feedback in the record form) and again on the server (the route), so a
// crafted request can never skip a hard block. Pure functions, no DB, no
// framework: the caller supplies plain numbers and dates.
//
// Hard blocks (errors) stop the record. Warnings do not — they describe what
// the allocation will do (spill past the next installment, or leave a
// shortfall) and require the admin to tick "I've reviewed the allocation".

export const PAYMENT_METHODS = ["Bank Transfer", "Cash", "Cheque", "POS", "Installment"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

// Methods whose reference is a real bank/teller slip and must be supplied.
const REFERENCE_REQUIRED_METHODS = new Set<string>(["Bank Transfer"]);

export type PaymentValidationInput = {
  amount: number;
  paymentDate: Date;
  paymentMethod: string;
  bankReference?: string | null;
  // Earliest date a payment can carry — the contract/transaction date.
  contractDate?: Date | null;
  // Total contract balance and how much of it is still outstanding, both
  // derived from confirmed payments (finance service) by the caller.
  totalPayable: number;
  outstandingBalance: number;
  // Amount currently due on the schedule — the next open installment's
  // remaining due. 0 when nothing is outstanding. Drives the spill/shortfall
  // warnings; never a gate.
  dueNow: number;
  // Bank references already recorded (any status except cancelled) that a new
  // reference must not silently duplicate. Normalised here.
  existingReferences?: (string | null | undefined)[];
  // Whether the admin has acknowledged the allocation review prompt.
  allocationReviewed?: boolean;
  // "now" injected so tests are deterministic; defaults to the real clock.
  now?: Date;
};

export type PaymentValidationIssue = {
  code: string;
  message: string;
  meta?: Record<string, number | string>;
};

export type PaymentValidationResult = {
  errors: PaymentValidationIssue[];
  warnings: PaymentValidationIssue[];
  // True when warnings exist and the admin has not yet acknowledged them.
  requiresAcknowledgement: boolean;
};

// Trim, collapse internal whitespace, upper-case — so " trf-88231 " and
// "TRF-88231" are the same reference.
export function normalizeReference(ref: string | null | undefined): string {
  return (ref ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

function sameDay(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

export function validatePayment(input: PaymentValidationInput): PaymentValidationResult {
  const now = input.now ?? new Date();
  const errors: PaymentValidationIssue[] = [];
  const warnings: PaymentValidationIssue[] = [];

  // ---- Amount ------------------------------------------------------------
  if (!Number.isFinite(input.amount) || !Number.isInteger(input.amount)) {
    errors.push({ code: "AMOUNT_NOT_WHOLE", message: "Enter a whole-naira amount (no decimals)." });
  } else if (input.amount <= 0) {
    errors.push({ code: "AMOUNT_NOT_POSITIVE", message: "Enter an amount greater than zero." });
  } else if (input.amount > input.outstandingBalance) {
    const overBy = input.amount - input.outstandingBalance;
    errors.push({
      code: "AMOUNT_EXCEEDS_OUTSTANDING",
      message: `This payment of ${formatNaira(input.amount)} exceeds the outstanding balance of ${formatNaira(input.outstandingBalance)} by ${formatNaira(overBy)}. Reduce the amount — payments above the outstanding balance are rejected.`,
      meta: { overBy, outstanding: input.outstandingBalance },
    });
  }

  // ---- Date --------------------------------------------------------------
  if (Number.isNaN(input.paymentDate.getTime())) {
    errors.push({ code: "DATE_INVALID", message: "Enter a valid payment date." });
  } else {
    if (input.contractDate && input.paymentDate.getTime() < input.contractDate.getTime() && !sameDay(input.paymentDate, input.contractDate)) {
      errors.push({
        code: "DATE_BEFORE_CONTRACT",
        message: "The payment date is before the contract date. Use the date the money was actually received.",
      });
    }
    if (input.paymentDate.getTime() > now.getTime() && !sameDay(input.paymentDate, now)) {
      errors.push({ code: "DATE_IN_FUTURE", message: "The payment date is in the future. Use the date the money was received." });
    }
  }

  // ---- Bank reference ----------------------------------------------------
  const ref = normalizeReference(input.bankReference);
  if (REFERENCE_REQUIRED_METHODS.has(input.paymentMethod) && ref.length === 0) {
    errors.push({
      code: "REFERENCE_REQUIRED",
      message: `A bank/teller reference is required for ${input.paymentMethod}. Enter the reference from the transfer slip.`,
    });
  } else if (ref.length > 0) {
    const duplicate = (input.existingReferences ?? [])
      .map((r) => normalizeReference(r))
      .some((r) => r.length > 0 && r === ref);
    if (duplicate) {
      errors.push({
        code: "REFERENCE_DUPLICATE",
        message: `The reference "${input.bankReference?.trim()}" is already recorded on this transaction. Each transfer has its own reference — check the slip, or leave it blank for a non-transfer method.`,
      });
    }
  }

  // ---- Warnings (allocation shape) --------------------------------------
  const amountOk = Number.isInteger(input.amount) && input.amount > 0 && input.amount <= input.outstandingBalance;
  if (amountOk && input.dueNow > 0) {
    if (input.amount > input.dueNow) {
      warnings.push({
        code: "OVERPAYMENT_SPILL",
        message: `This payment is more than the ${formatNaira(input.dueNow)} due on the next installment, so the extra ${formatNaira(input.amount - input.dueNow)} will be applied to later installments.`,
        meta: { dueNow: input.dueNow, spill: input.amount - input.dueNow },
      });
    } else if (input.amount < input.dueNow) {
      warnings.push({
        code: "UNDERPAYMENT_SHORTFALL",
        message: `This is less than the ${formatNaira(input.dueNow)} due on the next installment, leaving ${formatNaira(input.dueNow - input.amount)} still outstanding on it.`,
        meta: { dueNow: input.dueNow, shortfall: input.dueNow - input.amount },
      });
    }
  }

  return {
    errors,
    warnings,
    requiresAcknowledgement: warnings.length > 0 && input.allocationReviewed !== true,
  };
}
