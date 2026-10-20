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
      "Librum took this book down. You can't publish it again until we review it. Questions? Write to support@librum.al",
    );
    expect(TAKEN_DOWN_DELETE_MESSAGE).toBe(
      "This book was taken down by Librum and can't be deleted until we review it. Questions? Write to support@librum.al",
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
      "Taken down by Librum on 19 Oct 2026. Reason: Copyright complaint.",
      "Send proof.",
      "We also unpublished: Set A, Set B.",
      "Questions? Write to support@librum.al",
    ]);
    expect(
      buildAuthorTakedownNoticeLines(
        { takenDownAt: "2026-10-19T10:00:00Z", reason: "other", message: "Done!", bundleTitles: [] },
        formatDate,
      ),
    ).toEqual([
      "Taken down by Librum on 19 Oct 2026. Reason: Other.",
      "Done!",
      "Questions? Write to support@librum.al",
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
