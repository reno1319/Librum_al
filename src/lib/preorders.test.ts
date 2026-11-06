import { describe, expect, it } from "vitest";
import {
  addMonths,
  cancelPreorderNote,
  countWaitingReaders,
  finalFileLine,
  isInPreorderWindow,
  isValidPushDate,
  parseDay,
  parseReleaseChoice,
  preorderBlock,
  preorderDateWindow,
  preorderFileDueDate,
  preorderFinalFileState,
  preorderPushState,
  tiranaToday,
} from "@/lib/preorders";

// BD16 P2: the author-side pre-order rules. The database (P1) checks the
// same windows again; these keep the editor from offering what it would
// refuse.

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

describe("days", () => {
  it("parseDay keeps only real calendar days", () => {
    expect(parseDay("2026-12-12")).toBe("2026-12-12");
    expect(parseDay(" 2028-02-29 ")).toBe("2028-02-29");
    for (const bad of ["2027-02-29", "2026-13-01", "2026-1-1", "12/12/2026", "", null, 5]) {
      expect(parseDay(bad)).toBeNull();
    }
  });

  it("tiranaToday is the Tirana day, not the UTC one", () => {
    // 23:30 UTC in winter is 00:30 the next day in Tirana (UTC+1).
    expect(tiranaToday(new Date("2026-11-06T23:30:00Z"))).toBe("2026-11-07");
    // 22:30 UTC in summer is 00:30 the next day (UTC+2).
    expect(tiranaToday(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
    expect(tiranaToday(new Date("2026-11-06T12:00:00Z"))).toBe("2026-11-06");
  });

  it("addMonths matches PostgreSQL: the month's last day when it is shorter", () => {
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2027-08-31", 6)).toBe("2028-02-29");
    expect(addMonths("2026-11-06", 6)).toBe("2027-05-06");
    expect(addMonths("2026-12-31", 6)).toBe("2027-06-30");
  });
});

describe("the listing window (Q1 a: 14 days to 6 months, LB500)", () => {
  it("min is today + 14, max today + 6 months, both included", () => {
    expect(preorderDateWindow("2026-11-06")).toEqual({ min: "2026-11-20", max: "2027-05-06" });
    expect(isInPreorderWindow("2026-11-20", "2026-11-06")).toBe(true);
    expect(isInPreorderWindow("2027-05-06", "2026-11-06")).toBe(true);
    expect(isInPreorderWindow("2026-11-19", "2026-11-06")).toBe(false);
    expect(isInPreorderWindow("2027-05-07", "2026-11-06")).toBe(false);
  });

  it("the file is due 3 days before the release day", () => {
    expect(preorderFileDueDate("2026-12-12")).toBe("2026-12-09");
    expect(preorderFileDueDate("2027-03-02")).toBe("2027-02-27");
  });
});

describe("the one push (Q2 a, LB504)", () => {
  it("1 to 30 days later only", () => {
    expect(isValidPushDate("2027-01-20", "2027-01-21")).toBe(true);
    expect(isValidPushDate("2027-01-20", "2027-02-19")).toBe(true);
    expect(isValidPushDate("2027-01-20", "2027-01-20")).toBe(false);
    expect(isValidPushDate("2027-01-20", "2027-02-20")).toBe(false);
    expect(isValidPushDate("2027-01-20", "2027-01-19")).toBe(false);
  });

  it("not once used, and not after the file's due date", () => {
    const book = { release_date: "2027-01-20", preorder_slip_used: false };
    expect(preorderPushState(book, "2027-01-17")).toBe("available");
    expect(preorderPushState(book, "2027-01-18")).toBe("too_late");
    expect(preorderPushState({ ...book, preorder_slip_used: true }, "2026-12-01")).toBe("used");
  });
});

describe("who may be offered a pre-order", () => {
  const draft = { published_at: null, preorder_count: 0, pd_work_id: null, rightsBasis: "own_rights" };
  it("a never-published own-rights draft with fewer than 2 pre-orders", () => {
    expect(preorderBlock(draft)).toBeNull();
    expect(preorderBlock({ ...draft, preorder_count: 1 })).toBeNull();
  });
  it("Renato 11-06 a: never a book published before; Q3b a: never a third; D3: never public domain", () => {
    expect(preorderBlock({ ...draft, published_at: "2026-10-01T00:00:00Z" })).toBe("published_before");
    expect(preorderBlock({ ...draft, preorder_count: 2 })).toBe("used_up");
    expect(preorderBlock({ ...draft, rightsBasis: "public_domain" })).toBe("public_domain");
    expect(preorderBlock({ ...draft, pd_work_id: "w" })).toBe("public_domain");
  });
});

describe("parseReleaseChoice", () => {
  it("absent, now, preorder with a day, or invalid", () => {
    expect(parseReleaseChoice(form({}))).toEqual({ kind: "absent" });
    expect(parseReleaseChoice(form({ releaseMode: "now", releaseDate: "2027-01-01" }))).toEqual({ kind: "now" });
    expect(parseReleaseChoice(form({ releaseMode: "preorder", releaseDate: "2027-01-01" }))).toEqual({
      kind: "preorder",
      releaseDate: "2027-01-01",
    });
    expect(parseReleaseChoice(form({ releaseMode: "preorder" }))).toEqual({ kind: "invalid", reason: "date" });
    expect(parseReleaseChoice(form({ releaseMode: "later" }))).toEqual({ kind: "invalid", reason: "mode" });
  });
});

describe("the final manuscript", () => {
  it("approved, in review, saved but not sent, or missing", () => {
    expect(preorderFinalFileState({ bookFilePath: "a.epub", pendingFilePath: null, inReview: false })).toBe("approved");
    expect(preorderFinalFileState({ bookFilePath: null, pendingFilePath: "b.epub", inReview: true })).toBe("in_review");
    expect(preorderFinalFileState({ bookFilePath: null, pendingFilePath: "b.epub", inReview: false })).toBe(
      "saved_not_sent",
    );
    expect(preorderFinalFileState({ bookFilePath: null, pendingFilePath: null, inReview: true })).toBe("missing");
  });

  it("P1 re-audit: a saved-but-unsent file says it must be sent again, with its due date", () => {
    const line = finalFileLine("saved_not_sent", "2026-12-12");
    expect(line).toContain("nuk është dërguar");
    expect(line).toContain("pezullim");
    expect(line).toContain("9 dhjetor 2026");
  });
});

describe("cancelPreorderNote", () => {
  it("names the readers' email and whether the book can be pre-ordered again", () => {
    expect(cancelPreorderNote({ waiting: 3, preorderCount: 1 })).toContain("3 lexuesit");
    expect(cancelPreorderNote({ waiting: 3, preorderCount: 1 })).toContain("edhe një herë");
    expect(cancelPreorderNote({ waiting: 0, preorderCount: 2 })).toContain("vetëm si zakonisht");
    expect(cancelPreorderNote({ waiting: null, preorderCount: 1 })).toContain("marrin një email");
  });
});

describe("countWaitingReaders", () => {
  function client(result: { data: unknown; error: unknown }, calls: unknown[][]) {
    const chain = {
      select: (...a: unknown[]) => (calls.push(["select", ...a]), chain),
      in: (...a: unknown[]) => (calls.push(["in", ...a]), chain),
      is: (...a: unknown[]) => (calls.push(["is", ...a]), chain),
      returns: () => Promise.resolve(result),
    };
    return { from: (t: string) => (calls.push(["from", t]), chain) } as never;
  }

  it("counts only readers still waiting, for the books asked about", async () => {
    const calls: unknown[][] = [];
    const counts = await countWaitingReaders(
      client({ data: [{ book_id: "a" }, { book_id: "a" }, { book_id: "b" }, { book_id: "x" }], error: null }, calls),
      ["a", "b"],
    );
    expect(counts).toEqual(new Map([["a", 2], ["b", 1]]));
    expect(calls).toEqual([
      ["from", "preorder_notify_requests"],
      ["select", "book_id"],
      ["in", "book_id", ["a", "b"]],
      ["is", "notified_at", null],
      ["is", "book_cancelled_at", null],
    ]);
  });

  it("null when unreadable; no read for no books", async () => {
    expect(await countWaitingReaders(client({ data: null, error: { code: "x" } }, []), ["a"])).toBeNull();
    const calls: unknown[][] = [];
    expect(await countWaitingReaders(client({ data: [], error: null }, calls), [])).toEqual(new Map());
    expect(calls).toEqual([]);
  });
});
