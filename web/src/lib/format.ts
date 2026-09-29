/** ₹ with Indian digit grouping: ₹1,25,000 */
export function inr(v: number | null | undefined, decimals = false): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const neg = v < 0;
  const [whole, frac] = Math.abs(v).toFixed(2).split(".");
  const tail = whole.slice(-3);
  let head = whole.slice(0, -3);
  const groups: string[] = [];
  while (head.length > 2) {
    groups.unshift(head.slice(-2));
    head = head.slice(0, -2);
  }
  if (head) groups.unshift(head);
  const grouped = groups.length ? `${groups.join(",")},${tail}` : tail;
  return `${neg ? "-" : ""}₹${grouped}${decimals || frac !== "00" ? `.${frac}` : ""}`;
}

export function ago(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function clock(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function pct(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

export const ACTION_LABEL: Record<string, string> = {
  share_status: "Share status",
  request_info: "Ask for details",
  reverse_failed_debit: "Reverse failed debit",
  refund_duplicate: "Refund duplicate",
  tat_compensation: "TAT compensation",
  raise_dispute: "Raise dispute",
  block_instrument: "Block card / UPI",
  chargeback_credit: "Chargeback credit",
};

export const INTENT_LABEL: Record<string, string> = {
  failed_debit: "Failed UPI debit",
  refund_status: "Refund status",
  duplicate_charge: "Duplicate charge",
  wrong_beneficiary: "Wrong beneficiary",
  unauthorized: "Unauthorised",
  block_request: "Block request",
  kyc: "KYC",
  balance: "Balance",
  other: "Other",
};

export const short = (h: string | null | undefined, n = 10) => (h ? `${h.slice(0, n)}…` : "—");
