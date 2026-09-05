import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 AUTHOR-1A: source-level regression coverage for the
// Account name / Public author name split on /dashboard/profile. Same
// convention already established for pages with no DOM-rendering
// harness (see src/app/books/[id]/book-detail-metadata.test.ts) --
// these assert directly on the real page.tsx text, not a rendered tree.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("Dashboard Profile: Account name / Public author name split", () => {
  it("labels the display_name field 'Account name', not 'Name' or 'Legal name'", () => {
    expect(source).toContain("Account name");
    expect(source).not.toMatch(/>\s*Name\s*</);
    // "Legal name" is allowed to appear inside a comment explaining it's
    // deliberately NOT used as a label (Librum has no legal-name/KYC
    // verification) -- what must never exist is the literal JSX label.
    expect(source).not.toMatch(/>\s*Legal name\s*</);
  });

  it("gates the Public author name field on role === 'author'", () => {
    expect(source).toContain('profile?.role === "author"');
  });

  it("Public author name field resolves its defaultValue through resolvePublicAuthorName(), never a raw display_name fallback", () => {
    expect(source).toContain("import { resolvePublicAuthorName } from \"@/lib/author-name\";");
    expect(source).toContain("resolvePublicAuthorName(profile)");
  });

  it("the reader-facing supporting copy sits under Public author name, not under Account name", () => {
    const accountBlock = source.slice(
      source.indexOf("Account name"),
      source.indexOf("Public author name"),
    );
    const publicNameBlock = source.slice(
      source.indexOf("Public author name"),
      source.indexOf("Bio"),
    );
    expect(accountBlock).not.toContain("readers will see");
    expect(publicNameBlock).toContain("This is the name readers will see on your books and author page.");
  });

  it("includes the EPUB pen-name timing note near the Public author name field, concise and non-alarmist", () => {
    const publicNameBlock = source.slice(
      source.indexOf("Public author name"),
      source.indexOf("Bio"),
    );
    expect(publicNameBlock).toContain("If you publish under a pen name, set it before publishing.");
    expect(publicNameBlock).toContain("embedded in your EPUB file");
  });

  it("the public author name input is required when rendered (an author's form never submits it blank by omission)", () => {
    const publicNameFieldBlock = source.slice(
      source.indexOf('name="publicAuthorName"'),
      source.indexOf('name="publicAuthorName"') + 300,
    );
    expect(publicNameFieldBlock).toContain("required");
  });
});
