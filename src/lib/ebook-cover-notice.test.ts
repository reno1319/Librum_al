import { describe, expect, it } from "vitest";
import { EBOOK_COVER_NOT_INSIDE_MESSAGE, ebookCoverNotice, withEbookCoverWarning } from "./ebook-cover-notice";

// W7 r2 (Q1 b-lite): the fixed flag a post-save redirect carries when the
// cover could not be put inside a Librum-made ebook.
describe("withEbookCoverWarning", () => {
  it("leaves the URL untouched when nothing failed", () => {
    expect(withEbookCoverWarning("/dashboard?success=Ok", false)).toBe("/dashboard?success=Ok");
    expect(withEbookCoverWarning("/dashboard", false)).toBe("/dashboard");
  });

  it("adds only the flag, keeping every existing message as it is", () => {
    expect(withEbookCoverWarning("/dashboard?success=Ok&error=Bad", true)).toBe("/dashboard?success=Ok&error=Bad&ebook_cover=0");
    expect(withEbookCoverWarning("/dashboard", true)).toBe("/dashboard?ebook_cover=0");
  });
});

describe("ebookCoverNotice", () => {
  it("shows the one Librum sentence for the exact flag and nothing for anything else", () => {
    expect(ebookCoverNotice("0")).toBe(EBOOK_COVER_NOT_INSIDE_MESSAGE);
    for (const raw of [undefined, "", "1", "Hacked text", ["0"], " 0"]) {
      expect(ebookCoverNotice(raw)).toBeNull();
    }
  });

  it("is Albanian and asks the author to upload the cover again", () => {
    expect(EBOOK_COVER_NOT_INSIDE_MESSAGE).toContain("nuk u vendos dot brenda librit elektronik");
    expect(EBOOK_COVER_NOT_INSIDE_MESSAGE).toContain("ngarkoni kopertinën");
  });
});
