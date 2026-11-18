// DEL (del4 a): the optional "Pse po largoheni?" answers on the Account
// page. The codes are the ones account_deletion_feedback accepts
// (migration 20261118170000); the labels are what people see.
export const LEAVE_REASONS = [
  { code: "not_using", label: "Nuk e përdor më Librum-in" },
  { code: "no_books", label: "Nuk gjej libra që më interesojnë" },
  { code: "privacy", label: "Kam shqetësime për privatësinë" },
  { code: "other_account", label: "Kam një llogari tjetër" },
  { code: "other", label: "Tjetër" },
] as const;

export type LeaveReasonCode = (typeof LEAVE_REASONS)[number]["code"];

export const LEAVE_NOTE_MAX_LENGTH = 500;

export function parseLeaveReason(value: unknown): LeaveReasonCode | null {
  return LEAVE_REASONS.find((r) => r.code === value)?.code ?? null;
}

// The day (in Tirana) an instant falls on, as "YYYY-MM-DD", for the
// homepage message's ?until= (formatted again with formatDateOnly).
export function tiranaDay(timestamp: string): string | null {
  const instant = new Date(timestamp);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Tirane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
  return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : null;
}

export function isDayParam(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
