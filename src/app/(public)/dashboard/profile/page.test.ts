import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Source-level coverage for Dashboard > Profili (same convention as other
// pages with no DOM-rendering harness: assertions on the real page.tsx).
// AUTHOR PROFILI (build 1, approved picture sp2 a): one page with the
// account name, the main author name card and the pen names.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const pick = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

describe("Dashboard Profili (one page for authors)", () => {
  it("has the approved title and intro", () => {
    expect(source).toContain('title="Profili"');
    expect(source).toContain("Emri i llogarisë, emri juaj i autorit dhe pseudonimet, nëse keni.");
  });

  it("labels display_name 'Emri i llogarisë' with the private hint, never 'Legal name'", () => {
    expect(source).toContain("Emri i llogarisë");
    expect(source).toContain("Vetëm për llogarinë tuaj. Lexuesit nuk e shohin.");
    expect(source).not.toMatch(/>\s*Legal name\s*</);
  });

  it("Q1 b: the account name belongs to the main card's form, so its one Ruani saves both", () => {
    const field = pick('name="displayName"', "/>");
    expect(field).toContain("form={mainPenName ? MAIN_CARD_FORM_ID : undefined}");
    expect(source).toContain("id={isMain ? MAIN_CARD_FORM_ID : undefined}");
  });

  it("one writer for the author name: no publicAuthorName field; the main card edits the default pen name", () => {
    expect(source).not.toContain("publicAuthorName");
    expect(source).toContain("action={updatePenName.bind(null, penName.id)}");
    expect(source).toContain('{isMain ? "Emri juaj i autorit" : "Emri"}');
    expect(source).toContain("Ky emër shfaqet te librat tuaj dhe te faqja juaj e autorit.");
  });

  it("the pen names section: heading, text, '+ Shto pseudonim' opening a name box (Q2 a)", () => {
    expect(source).toContain("Pseudonimet (opsionale)");
    expect(source).toContain(
      "Botoni me një emër tjetër? Shtoni një pseudonim. Çdo pseudonim ka faqen e vet; e zgjidhni për çdo libër.",
    );
    const box = pick("<details", "</details>");
    expect(box).toContain("+ Shto pseudonim");
    expect(box).toContain("action={createPenName}");
    expect(box).toMatch(/name="name"[^>]*required/);
  });

  it("only a non-default, unused pen name can be deleted", () => {
    expect(source).toContain("{!isMain && !used && (");
    expect(source).toContain("Fshini pseudonimin");
  });
});
