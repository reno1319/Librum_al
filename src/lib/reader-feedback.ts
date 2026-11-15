// KOLIBER download count + K4 feedback button (Renato 2026-11-15).
// The database decides both (migration
// 20261115200000_download_count_feedback.sql); this file only checks the
// input before the call and turns the answers into the words people see.

// ------------------------------------------------------------
// The download count (count a: one per person who got the book; count c
// b: no download needed; word b: "shkarkime"; count b a: nothing at 0)
// ------------------------------------------------------------

// The line under the genre (the number, then the word), or null when
// there is nothing to show.
export function downloadCountText(count: number | null | undefined): { number: string; word: string } | null {
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0) return null;
  return {
    number: String(count).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0"),
    word: count === 1 ? "shkarkim" : "shkarkime",
  };
}

// The RPC answer: a non-negative integer, anything else is "no number".
export function parseDownloadCount(data: unknown): number | null {
  return typeof data === "number" && Number.isSafeInteger(data) && data >= 0 ? data : null;
}

// ------------------------------------------------------------
// The feedback button (feedback a b: signed in only; c a: kind + text
// required, up to 1,000 characters, the page attached)
// ------------------------------------------------------------

export const FEEDBACK_KINDS = ["problem", "idea"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_BODY_MAX = 1000;
export const FEEDBACK_PATH_MAX = 300;

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  problem: "Problem",
  idea: "Ide",
};

export function isFeedbackKind(value: unknown): value is FeedbackKind {
  return typeof value === "string" && (FEEDBACK_KINDS as readonly string[]).includes(value);
}

// The page the reader was on: the path only (no query, no hash, never
// another site). Anything else becomes "/".
export function feedbackPagePath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(path)) return "/";
  return path.length > FEEDBACK_PATH_MAX ? "/" : path;
}

const EDGE_SPACE = /^[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+|[\s\u00a0\u200b\u200c\u200d\u2060\ufeff]+$/g;

// The admin shows a stored path as a link only when it is exactly a
// clean site path (audit r1 F1: a backslash or a tab can make a browser
// open another site); anything else is plain text.
export function isCleanFeedbackPath(value: string): boolean {
  return feedbackPagePath(value) === value;
}

export type FeedbackInputCheck =
  | { ok: true; kind: FeedbackKind; body: string; pagePath: string }
  | { ok: false; error: string };

export const FEEDBACK_ERRORS = {
  kind: "Zgjidhni «Problem» ose «Ide».",
  empty: "Shkruani mesazhin tuaj.",
  long: "Mesazhi mund të ketë deri në 1000 shkronja.",
  signedOut: "Hyni në llogari për të na shkruar.",
  suspended: "Llogaria juaj është pezulluar. Na shkruani te support@librum.al.",
  tooMany: "Keni dërguar shumë mesazhe këtë orë. Provoni përsëri më vonë.",
  failed: "Mesazhi nuk u dërgua. Provoni përsëri.",
} as const;

export function checkFeedbackInput(kind: unknown, body: unknown, pagePath: unknown): FeedbackInputCheck {
  if (!isFeedbackKind(kind)) return { ok: false, error: FEEDBACK_ERRORS.kind };
  // Like the database: spaces, no-break and zero-width spaces at both ends.
  const text = typeof body === "string" ? body.replace(EDGE_SPACE, "") : "";
  if (text.length === 0) return { ok: false, error: FEEDBACK_ERRORS.empty };
  // The database counts characters (code points), like Array.from.
  if (Array.from(text).length > FEEDBACK_BODY_MAX) return { ok: false, error: FEEDBACK_ERRORS.long };
  return { ok: true, kind, body: text, pagePath: feedbackPagePath(pagePath) };
}

// submit_reader_feedback's refusals (LB510-LB514) as words.
export function feedbackErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "LB510":
      return FEEDBACK_ERRORS.suspended;
    case "LB511":
      return FEEDBACK_ERRORS.kind;
    case "LB512":
      return FEEDBACK_ERRORS.empty;
    case "LB514":
      return FEEDBACK_ERRORS.tooMany;
    default:
      return FEEDBACK_ERRORS.failed;
  }
}

// ------------------------------------------------------------
// The admin list (staff_list_reader_feedback)
// ------------------------------------------------------------

export type FeedbackStatusFilter = "open" | "done" | "all";

export function feedbackStatusFilter(value: unknown): FeedbackStatusFilter {
  return value === "done" || value === "all" ? value : "open";
}

export type AdminFeedbackRow = {
  id: string;
  kind: FeedbackKind;
  body: string;
  pagePath: string;
  senderEmail: string | null;
  createdAt: string;
  doneAt: string | null;
};

// Rows that are not exactly the shape the function returns are dropped.
export function parseAdminFeedbackRows(data: unknown): AdminFeedbackRow[] {
  if (!Array.isArray(data)) return [];
  const rows: AdminFeedbackRow[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const r = entry as Record<string, unknown>;
    if (typeof r.id !== "string" || !isFeedbackKind(r.kind) || typeof r.body !== "string") continue;
    if (typeof r.page_path !== "string" || typeof r.created_at !== "string") continue;
    if (r.sender_email !== null && typeof r.sender_email !== "string") continue;
    if (r.done_at !== null && typeof r.done_at !== "string") continue;
    rows.push({
      id: r.id,
      kind: r.kind,
      body: r.body,
      pagePath: r.page_path,
      senderEmail: r.sender_email,
      createdAt: r.created_at,
      doneAt: r.done_at,
    });
  }
  return rows;
}
