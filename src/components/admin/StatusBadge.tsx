// One shared status pill: one status→color map for every domain
// (bookings, payments, transactions, receipts, installments, outbox).
// Import this instead of writing a local badge function.

const GREEN_SOLID = "bg-[#1F6B3E] text-white border-[#1F6B3E]";
const DARK_SOLID = "bg-[#16281D] text-white border-[#16281D]";
const SAND_SOLID = "bg-[#E4D8C1] text-[#6B6252] border-[#E4D8C1]";
const RED_SOLID = "bg-[#A6402F] text-white border-[#A6402F]";
const GOLD_SOLID = "bg-[#C89B3C] text-white border-[#C89B3C]";
const OUTLINE_STONE = "bg-transparent text-[#6B6252] border border-[#D8CFC0]";
const OUTLINE_GOLD = "bg-transparent text-[#8B6B1F] border border-[#C89B3C]";
const OUTLINE_BLUE = "bg-transparent text-[#1E3A5F] border border-[#C7D2E0]";
const AMBER_SOFT = "bg-[#FFFBEB] text-[#92400E] border-[#FDE68A]";
const GREEN_SOFT = "bg-[#ECFDF5] text-[#065F46] border-[#A7F3D0]";
const RED_SOFT = "bg-[#FEF2F2] text-[#9F1239] border-[#FECACA]";
const GRAY_SOFT = "bg-[#F3F4F6] text-[#4B5563] border-[#E5E7EB]";
const TEAL_SOFT = "bg-[#E0F2F1] text-[#0D3328] border-[#B2DFDB]";

export const STATUS_STYLES: Record<string, string> = {
  // bookings
  new: OUTLINE_STONE,
  under_review: OUTLINE_GOLD,
  on_hold: OUTLINE_STONE,
  approved: GREEN_SOLID,
  rescheduled: OUTLINE_BLUE,
  active: DARK_SOLID,
  closed: SAND_SOLID,
  // outcomes / lead temperature
  sold: GREEN_SOFT,
  interested: GOLD_SOLID,
  not_sold: GRAY_SOFT,
  cold: OUTLINE_BLUE,
  warm: GOLD_SOLID,
  hot: RED_SOLID,
  // payments / transactions / receipts — decided states are solid or soft green
  CONFIRMED: GREEN_SOLID,
  PAID_IN_FULL: DARK_SOLID,
  PAID: GREEN_SOFT,
  GENERATED: OUTLINE_BLUE,
  generated: OUTLINE_BLUE,
  sent: GREEN_SOLID,
  SENT: GREEN_SOLID,
  PENDING_VERIFICATION: OUTLINE_GOLD,
  pending: OUTLINE_GOLD,
  PENDING: GRAY_SOFT,
  DUE: GRAY_SOFT,
  PARTIALLY_PAID: AMBER_SOFT,
  OVERDUE: RED_SOFT,
  FAILED: RED_SOLID,
  failed: RED_SOLID,
  CANCELLED: GRAY_SOFT,
  WAIVED: GRAY_SOFT,
  DRAFT: OUTLINE_STONE,
  draft: OUTLINE_STONE,
  // finance display labels (derive from confirmed money, not stored enums)
  Paid: GREEN_SOFT,
  Late: RED_SOFT,
  Partial: AMBER_SOFT,
  Pending: GRAY_SOFT,
  // Row is scheduled below what the client paid: the contract is settled, so
  // this row is never late and never red.
  Settled: TEAL_SOFT,
  // receipt sources
  BOOKING_FLOW: TEAL_SOFT,
  PAYMENT_CONFIRMATION: TEAL_SOFT,
  ADMIN_MANUAL: DARK_SOLID,
};

const LABEL_OVERRIDES: Record<string, string> = {
  under_review: "Under Review",
  on_hold: "On Hold",
  not_sold: "Not sold",
  PENDING_VERIFICATION: "Pending verification",
  PAID_IN_FULL: "Paid in full",
  PARTIALLY_PAID: "Partial",
  BOOKING_FLOW: "Booking",
  PAYMENT_CONFIRMATION: "Payment",
  ADMIN_MANUAL: "Manual",
};

export function statusLabel(status: string): string {
  if (LABEL_OVERRIDES[status]) return LABEL_OVERRIDES[status];
  return status
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function statusStyle(status: string): string {
  return STATUS_STYLES[status] ?? OUTLINE_STONE;
}

export default function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  return (
    <span className={`inline-flex px-2.5 py-1 rounded-full text-[11px] font-medium border ${statusStyle(status)} ${className}`}>
      {statusLabel(status)}
    </span>
  );
}
