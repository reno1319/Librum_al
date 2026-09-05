import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 AUTHOR-1A: source-level regression coverage for the one
// admin surface the AUTHOR-1 audit identified as already showing a
// single author name before this feature existed (a moderator reviewing
// a reported book needs to see both which pen name the public sees AND
// which account is actually responsible). Same source-level convention
// already established for pages with no DOM-rendering harness (see
// src/app/books/[id]/book-detail-metadata.test.ts) -- these assert
// directly on the real page.tsx text, not a rendered tree.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("Admin book report detail: public author name vs. account name", () => {
  it("selects public_author_name alongside display_name for the profiles lookup", () => {
    expect(source).toContain('select("id, display_name, public_author_name")');
  });

  it("resolves the author's public name through the shared resolvePublicAuthorName() helper, not a raw .display_name read", () => {
    expect(source).toContain("import { resolvePublicAuthorName } from \"@/lib/author-name\";");
    expect(source).toContain("resolvePublicAuthorName(profileById.get(report.books.author_id))");
  });

  it("renders both labels distinctly: 'Public author name:' and 'Account name:'", () => {
    expect(source).toContain("Public author name: {authorPublicName}");
    expect(source).toContain("Account name: {authorAccountName}");
  });

  it("suppresses the redundant Account name line when it equals the public name", () => {
    expect(source).toContain("authorAccountName && authorAccountName !== authorPublicName");
  });

  it("never resolves the author's public name from a hardcoded fallback string alone -- falls back to the already-resolved account name/unknown-author copy", () => {
    const publicNameLine = source.match(/const authorPublicName = report\.books[\s\S]*?: null;/)![0];
    expect(publicNameLine).toContain("?? authorAccountName");
  });
});
