import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_REVIEW_COLUMNS,
  BOOK_REVIEW_STATUSES,
  LIVE_FILES_WARNING,
  REVIEW_CHECKLIST_ITEMS,
  REVIEW_STATUS_LABELS,
  SENT_FOR_REVIEW_MESSAGE,
  buildAuthorReviewNotices,
  buildAuthorSentBackNoticeLines,
  publishControlLabel,
  type AuthorReviewRow,
} from "./book-review-copy";

// ADMIN-3-REVIEW: the shared words, the author column list (R1) and the
// per-book notice rule (F, P4), against the migration where they meet.

const migration = readFileSync(
  path.join(__dirname, "../../supabase/migrations/20261020120000_book_reviews.sql"),
  "utf8",
);

const BOOK = "c3d4e5f6-2222-4222-8222-abcdef222222";
const OTHER = "c3d4e5f6-3333-4333-8333-abcdef333333";

function row(overrides: Partial<AuthorReviewRow>): AuthorReviewRow {
  return {
    book_id: BOOK,
    book_title: "T",
    author_id: "a",
    status: "pending",
    submitted_at: "2026-10-05T00:00:00Z",
    reason: null,
    message_to_author: null,
    decided_at: null,
    ...overrides,
  };
}

describe("AUTHOR_REVIEW_COLUMNS (R1)", () => {
  it("is exactly the column list the migration grants to authenticated", () => {
    const grant = migration.match(/grant select \(([^)]+)\)\s+on (?:table )?public\.book_reviews\s+to authenticated/i);
    expect(grant).not.toBeNull();
    const granted = grant![1].split(",").map((c) => c.trim());
    expect(AUTHOR_REVIEW_COLUMNS.split(",").map((c) => c.trim())).toEqual(granted);
    for (const secret of ["file_path", "cover_path", "checklist", "decided_by", "id"]) {
      expect(granted).not.toContain(secret);
    }
  });

  it("the status list matches the table's check", () => {
    const check = migration.match(/status in \(([^)]+)\)/i);
    expect(check).not.toBeNull();
    expect(check![1].split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...BOOK_REVIEW_STATUSES]);
    expect(Object.keys(REVIEW_STATUS_LABELS).sort()).toEqual([...BOOK_REVIEW_STATUSES].sort());
  });

  it("the checklist keys are the ones admin_approve_book_review requires", () => {
    const required = JSON.stringify(Object.fromEntries(REVIEW_CHECKLIST_ITEMS.map((item) => [item.key, true]))).replace(/,/g, ", ").replace(/:/g, ": ");
    expect(migration).toContain(`p_checklist is distinct from '${required}'::jsonb`);
  });
});

describe("buildAuthorReviewNotices (F, P4)", () => {
  it("pending: In review, no send-back notice", () => {
    expect(buildAuthorReviewNotices([row({})]).get(BOOK)).toEqual({ inReview: true, sentBack: null });
  });

  it("the newest review is a send back: the notice", () => {
    const notices = buildAuthorReviewNotices([
      row({ status: "approved", submitted_at: "2026-10-01T00:00:00Z", decided_at: "2026-10-02T00:00:00Z" }),
      row({ status: "sent_back", reason: "broken_file", message_to_author: "Fix", decided_at: "2026-10-06T00:00:00Z" }),
    ]);
    expect(notices.get(BOOK)).toEqual({
      inReview: false,
      sentBack: { sentBackAt: "2026-10-06T00:00:00Z", reason: "broken_file", message: "Fix" },
    });
  });

  it("a newer review hides an older send back", () => {
    const notices = buildAuthorReviewNotices([
      row({ status: "sent_back", submitted_at: "2026-10-01T00:00:00Z", reason: "other", message_to_author: "x", decided_at: "2026-10-02T00:00:00Z" }),
      row({ status: "withdrawn", submitted_at: "2026-10-03T00:00:00Z", decided_at: "2026-10-04T00:00:00Z" }),
    ]);
    expect(notices.has(BOOK)).toBe(false);
  });

  it("a pending row submitted with a decided one counts as newer", () => {
    const notices = buildAuthorReviewNotices([
      row({ status: "sent_back", reason: "other", message_to_author: "x", decided_at: "2026-10-05T00:00:00Z" }),
      row({ status: "pending" }),
    ]);
    expect(notices.get(BOOK)).toEqual({ inReview: true, sentBack: null });
  });

  it("rows without a book (deleted) are ignored; books are kept apart", () => {
    const notices = buildAuthorReviewNotices([row({ book_id: null }), row({ book_id: OTHER })]);
    expect([...notices.keys()]).toEqual([OTHER]);
  });
});

describe("words", () => {
  it("the send-back notice reads in order and ends with where to ask", () => {
    expect(
      buildAuthorSentBackNoticeLines(
        { sentBackAt: "2026-10-19T10:00:00Z", reason: "broken_file", message: "The file is broken" },
        () => "Oct 19, 2026",
      ),
    ).toEqual([
      "Librum jua ktheu këtë libër për ndryshime më Oct 19, 2026. Arsyeja: Skedar i gabuar ose i dëmtuar.",
      "The file is broken.",
      "Rregullojeni dhe dërgojeni përsëri për shqyrtim.",
      "Pyetje? Na shkruani te support@librum.al",
    ]);
  });

  it("the publish control's label (B)", () => {
    expect(publishControlLabel(false)).toBe("Dërgojeni për shqyrtim");
    expect(publishControlLabel(true)).toBe("Publikoni");
  });

  it("no author-facing sentence promises a review time", () => {
    for (const text of [SENT_FOR_REVIEW_MESSAGE, LIVE_FILES_WARNING]) {
      expect(text).not.toMatch(/\b(hours?|days?|within|soon|today)\b/i);
    }
  });
});
