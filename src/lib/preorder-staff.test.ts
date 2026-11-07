import { describe, expect, it } from "vitest";
import {
  encodeRunCounts,
  finalFileReleasesNow,
  isListingTooLate,
  liftPreorderLine,
  parseRunCounts,
  preorderJobMayRun,
  resendDueAfterSendBack,
  reviewKind,
  runCountsLine,
  staffFinalFileLine,
  tiranaHour,
} from "./preorder-staff";

// BD16 P3: the staff side's pre-order rules. Each mirrors a database rule
// of migration 20261106120000 (BD16 P1); the boundaries are pinned here.
describe("reviewKind", () => {
  const k = (bookStatus: string, bookFilePath: string | null, reviewFilePath: string | null, reviewReleaseDate: string | null) =>
    reviewKind({ bookStatus, bookFilePath, reviewFilePath, reviewReleaseDate });
  it("tells a listing, a final file, a pre-order's changes, a live book's changes and a plain publish apart", () => {
    expect(k("draft", null, null, "2026-12-12")).toBe("listing");
    expect(k("draft", "f", "f", "2026-12-12")).toBe("listing");
    expect(k("draft", "f", "f", null)).toBe("publish");
    expect(k("preorder", null, "f", null)).toBe("final_file");
    expect(k("preorder", null, null, null)).toBe("preorder_changes");
    expect(k("preorder", "f", "g", null)).toBe("preorder_changes");
    expect(k("published", "f", "g", null)).toBe("live_changes");
  });
});

describe("isListingTooLate (LB506)", () => {
  it("without a file: refused only once the file due date (release - 3) has passed", () => {
    expect(isListingTooLate({ releaseDate: "2026-11-20", hasFile: false, today: "2026-11-17" })).toBe(false);
    expect(isListingTooLate({ releaseDate: "2026-11-20", hasFile: false, today: "2026-11-18" })).toBe(true);
  });
  it("with a file: refused on the release day itself", () => {
    expect(isListingTooLate({ releaseDate: "2026-11-20", hasFile: true, today: "2026-11-19" })).toBe(false);
    expect(isListingTooLate({ releaseDate: "2026-11-20", hasFile: true, today: "2026-11-20" })).toBe(true);
  });
});

describe("final file dates", () => {
  it("approving on the release day releases it (BD15 Q3)", () => {
    expect(finalFileReleasesNow("2026-11-20", "2026-11-19")).toBe(false);
    expect(finalFileReleasesNow("2026-11-20", "2026-11-20")).toBe(true);
  });
  it("Q5 a: after a send-back, the later of the due date and 3 days on", () => {
    expect(resendDueAfterSendBack("2026-12-20", "2026-11-06")).toBe("2026-12-17");
    expect(resendDueAfterSendBack("2026-11-20", "2026-11-16")).toBe("2026-11-19");
    expect(resendDueAfterSendBack("2026-11-20", "2026-11-25")).toBe("2026-11-28");
  });
  it("after a lifted suspension staff are told the author must send the file again", () => {
    expect(staffFinalFileLine("saved_not_sent", "2026-12-12", "2026-11-06")).toContain("must send the final file again");
    expect(staffFinalFileLine("missing", "2026-12-12", "2026-11-06")).toBe("No final file yet. Due 9 Dec 2026.");
  });
});

describe("the owner's run: not before 08:00 Tirana", () => {
  it("in winter (UTC+1) 06:59 UTC is too early, 07:00 UTC is 08:00", () => {
    expect(tiranaHour(new Date("2026-11-06T06:59:00Z"))).toBe(7);
    expect(preorderJobMayRun(new Date("2026-11-06T06:59:59Z"))).toBe(false);
    expect(preorderJobMayRun(new Date("2026-11-06T07:00:00Z"))).toBe(true);
  });
  it("in summer (UTC+2) 06:00 UTC is 08:00", () => {
    expect(preorderJobMayRun(new Date("2026-07-06T05:59:00Z"))).toBe(false);
    expect(preorderJobMayRun(new Date("2026-07-06T06:00:00Z"))).toBe(true);
  });
  it("late evening runs (23:00 Tirana)", () => {
    expect(preorderJobMayRun(new Date("2026-11-06T22:30:00Z"))).toBe(true);
  });
});

describe("the run result travels as digits only", () => {
  it("round-trips and builds its line", () => {
    const counts = { released: 1, slipped: 2, cancelled: 0, overdue: 3, failed: 0 };
    expect(parseRunCounts(encodeRunCounts(counts))).toEqual(counts);
    expect(runCountsLine(counts)).toBe("Pre-order run done: 1 released, 2 moved 30 days later, 0 cancelled, 3 overdue.");
    expect(runCountsLine({ ...counts, failed: 1 })).toContain("1 couldn't be processed");
  });
  it.each([undefined, "", "1.2.3.4", "1.2.3.4.5.6", "a.b.c.d.e", "1.2.3.4.<b>", "123456.0.0.0.0"])("refuses %j", (raw) => {
    expect(parseRunCounts(raw)).toBeNull();
  });
});

describe("liftPreorderLine (Renato 11-06, a: the dates stay)", () => {
  const today = "2026-11-20";
  const book = { title: "T", releaseDate: "2026-11-21", slipUsed: false, hasApprovedFile: false };
  it("a due date passed during the suspension: the next run moves the date, or cancels when the move is used", () => {
    expect(liftPreorderLine(book, today)).toContain("moves its date 30 days later");
    expect(liftPreorderLine({ ...book, slipUsed: true }, today)).toContain("cancels it");
  });
  it("a due date still ahead, or an approved file: no miss", () => {
    expect(liftPreorderLine({ ...book, releaseDate: "2026-11-23" }, today)).toContain("final file due 20 Nov 2026");
    expect(liftPreorderLine({ ...book, hasApprovedFile: true }, today)).toContain("comes out 21 Nov 2026");
    expect(liftPreorderLine({ ...book, hasApprovedFile: true, releaseDate: "2026-11-19" }, today)).toContain("releases it");
  });
});
