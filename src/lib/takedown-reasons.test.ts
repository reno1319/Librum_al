import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTHOR_TAKEDOWN_COLUMNS,
  TAKEDOWN_PREFILL_MESSAGES,
  TAKEDOWN_REASONS,
  TAKEDOWN_REASON_LABELS,
  TAKEN_DOWN_DELETE_MESSAGE,
  TAKEN_DOWN_PUBLISH_MESSAGE,
  buildAuthorTakedownNoticeLines,
  isTakedownReason,
  takedownReasonForReport,
  takedownReasonLabel,
  SEND_BACK_MESSAGE_MAX_LENGTH,
  SEND_BACK_PREFILL_MESSAGES,
  SEND_BACK_REASONS,
  isSendBackReason,
} from "./takedown-reasons";

// ADMIN-2-TAKEDOWN: the shared words, and their agreement with the
// migration (the RPC writes the label into the report's admin_notes;
// the column grant fixes what an author session may select).
const migration = readFileSync(
  path.join(__dirname, "../../supabase/migrations/20261020080000_book_takedowns.sql"),
  "utf8",
);

describe("takedown reasons", () => {
  it("has the five agreed labels", () => {
    expect(TAKEDOWN_REASONS.map((r) => TAKEDOWN_REASON_LABELS[r])).toEqual([
      "Copyright complaint",
      "Breaks content rules",
      "Wrong or broken file",
      "Author asked",
      "Other",
    ]);
  });

  it("matches the RPC's own CASE, label for label", () => {
    for (const reason of TAKEDOWN_REASONS) {
      expect(migration).toContain(`when '${reason}' then '${TAKEDOWN_REASON_LABELS[reason].replace(/'/g, "''")}'`);
    }
    // ... and the table's own check names the same five codes.
    const check = migration.match(/book_takedowns_reason_check\s+check\s*\(\s*reason in \(([^)]+)\)/i);
    expect(check).not.toBeNull();
    expect(check![1].split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...TAKEDOWN_REASONS]);
  });

  it("reads an unknown stored code as Other", () => {
    expect(takedownReasonLabel("copyright")).toBe("Copyright complaint");
    expect(takedownReasonLabel("legacy")).toBe("Other");
    expect(isTakedownReason("other")).toBe(true);
    expect(isTakedownReason("Other")).toBe(false);
  });

  it("prefills every reason but Other, and starts a report on the matching reason", () => {
    for (const reason of TAKEDOWN_REASONS) {
      expect(TAKEDOWN_PREFILL_MESSAGES[reason].length > 0).toBe(reason !== "other");
    }
    expect(takedownReasonForReport("Copyright infringement")).toBe("copyright");
    expect(takedownReasonForReport("Inappropriate or offensive content")).toBe("content_rules");
    expect(takedownReasonForReport("Spam or misleading listing")).toBe("other");
    expect(takedownReasonForReport(null)).toBe("other");
  });
});

describe("the author's words (G, M5)", () => {
  it("uses the agreed publish and delete refusals", () => {
    expect(TAKEN_DOWN_PUBLISH_MESSAGE).toBe(
      "Librum e hoqi këtë libër. Nuk mund ta publikoni përsëri derisa ta shqyrtojmë. Pyetje? Na shkruani te support@librum.al",
    );
    expect(TAKEN_DOWN_DELETE_MESSAGE).toBe(
      "Ky libër u hoq nga Librum dhe nuk mund të fshihet derisa ta shqyrtojmë. Pyetje? Na shkruani te support@librum.al",
    );
  });

  it("builds the notice lines, with the bundles only when there are any", () => {
    const formatDate = () => "19 Oct 2026";
    expect(
      buildAuthorTakedownNoticeLines(
        { takenDownAt: "2026-10-19T10:00:00Z", reason: "copyright", message: "Send proof", bundleTitles: ["Set A", "Set B"] },
        formatDate,
      ),
    ).toEqual([
      "Hequr nga Libraria më 19 Oct 2026. Arsyeja: Ankesë për të drejtën e autorit.",
      "Send proof.",
      "Hoqëm nga publikimi edhe: Set A, Set B.",
      "Pyetje? Na shkruani te support@librum.al",
    ]);
    expect(
      buildAuthorTakedownNoticeLines(
        { takenDownAt: "2026-10-19T10:00:00Z", reason: "other", message: "Done!", bundleTitles: [] },
        formatDate,
      ),
    ).toEqual([
      "Hequr nga Libraria më 19 Oct 2026. Arsyeja: Tjetër.",
      "Done!",
      "Pyetje? Na shkruani te support@librum.al",
    ]);
  });
});

describe("AUTHOR_TAKEDOWN_COLUMNS (R1)", () => {
  it("is exactly the columns granted to authenticated -- never id, never *", () => {
    const grant = migration.match(/grant select \(([^)]+)\)\s+on (?:table )?public\.book_takedowns\s+to authenticated/i);
    expect(grant).not.toBeNull();
    const granted = grant![1].split(",").map((c) => c.trim());
    expect(AUTHOR_TAKEDOWN_COLUMNS.split(",").map((c) => c.trim())).toEqual(granted);
    expect(granted).not.toContain("id");
    expect(AUTHOR_TAKEDOWN_COLUMNS).not.toContain("*");
  });
});

// ADMIN-3-REVIEW (S7, N7): Send back reuses the takedown list without
// "Author asked"; its codes are exactly what book_reviews.reason accepts.
describe("send-back reasons (ADMIN-3)", () => {
  const reviewMigration = readFileSync(
    path.join(__dirname, "../../supabase/migrations/20261020120000_book_reviews.sql"),
    "utf8",
  );

  it("are the takedown reasons without author_asked, in the same order", () => {
    expect([...SEND_BACK_REASONS]).toEqual(TAKEDOWN_REASONS.filter((r) => r !== "author_asked"));
    expect(SEND_BACK_REASONS.map((r) => TAKEDOWN_REASON_LABELS[r])).toEqual([
      "Copyright complaint",
      "Breaks content rules",
      "Wrong or broken file",
      "Other",
    ]);
  });

  it("match book_reviews_reason_check", () => {
    const check = reviewMigration.match(/book_reviews_reason_check\s+check\s*\(\s*reason in \(([^)]+)\)/i);
    expect(check).not.toBeNull();
    expect(check![1].split(",").map((c) => c.trim().replace(/'/g, ""))).toEqual([...SEND_BACK_REASONS]);
  });

  it("isSendBackReason accepts exactly those codes", () => {
    for (const r of SEND_BACK_REASONS) expect(isSendBackReason(r)).toBe(true);
    for (const v of ["author_asked", "Copyright", "", null, undefined, 1]) expect(isSendBackReason(v)).toBe(false);
  });

  it("prefills every reason but Other, within the message limit, with no review-time promise", () => {
    expect(SEND_BACK_PREFILL_MESSAGES.other).toBe("");
    for (const r of SEND_BACK_REASONS.filter((x) => x !== "other")) {
      const text = SEND_BACK_PREFILL_MESSAGES[r];
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(SEND_BACK_MESSAGE_MAX_LENGTH);
      expect(text).toBe(text.trim());
      expect(text).not.toMatch(/\b(hours?|days?|within)\b/i);
    }
  });

  it("the message limit mirrors book_reviews_message_to_author_check", () => {
    expect(reviewMigration).toMatch(
      new RegExp(`book_reviews_message_to_author_check\\s+check \\(char_length\\(message_to_author\\) between 1 and ${SEND_BACK_MESSAGE_MAX_LENGTH}`),
    );
  });
});
