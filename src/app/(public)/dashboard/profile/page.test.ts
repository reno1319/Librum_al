import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Source-level coverage for Dashboard > Profili (same convention as other
// pages with no DOM-rendering harness: assertions on the real page.tsx).
// AUTHOR PROFILI (build 1, approved picture sp2 a): one page with the
// account name, the main author name card and the pen names.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
// BUILD 2a-2: the card itself moved to pen-name-card.tsx (shared with the
// house's Autorët tab).
const card = readFileSync(path.join(__dirname, "pen-name-card.tsx"), "utf8");
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
    expect(card).toContain('id={kind === "main" ? MAIN_CARD_FORM_ID : undefined}');
  });

  it("one writer for the author name: no publicAuthorName field; the main card edits the default pen name", () => {
    expect(source).not.toContain("publicAuthorName");
    expect(card).toContain("action={updatePenName.bind(null, penName.id)}");
    expect(card).toContain('nameLabel: "Emri juaj i autorit"');
    expect(source).toContain('kind={isMain ? (isHouse ? "house" : "main") : "pseudonym"}');
    expect(card).toContain("Ky emër shfaqet te librat tuaj dhe te faqja juaj e autorit.");
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
    expect(card).toContain("{wording.deleteLabel && !isMain && !used && (");
    expect(card).toContain('deleteLabel: "Fshini pseudonimin"');
  });
});

// BUILD 2a-2 (approved picture 6): a publishing house's Profili.
describe("Dashboard Profili for a publishing house", () => {
  const house = pick("if (isHouse) {", "\n  return (\n    <main");

  it("reads the account kind", () => {
    expect(source).toContain('.select("display_name, account_kind")');
    expect(source).toContain('const isHouse = profile?.account_kind === "publishing_house";');
  });

  it("shows only the house card, with the approved intro; no account name, no pseudonyms", () => {
    expect(house).toContain('title="Profili"');
    expect(house).toContain("Faqja publike e shtëpisë suaj botuese. Autorët i shtoni te Autorët.");
    expect(house).toContain("penNameCard(mainPenName)");
    expect(house).not.toContain("accountNameField");
    expect(house).not.toContain("Pseudonimet");
    expect(house).not.toContain("createPenName");
  });

  it("the house card says logo, house name and about, and has no delete", () => {
    const wording = card.slice(card.indexOf("  house: {"), card.indexOf("  houseAuthor: {"));
    expect(wording).toContain('nameLabel: "Emri i shtëpisë botuese"');
    expect(wording).toContain('bioLabel: "Rreth shtëpisë botuese (opsionale)"');
    expect(wording).toContain(
      'bioPlaceholder: "Disa fjali për shtëpinë tuaj botuese, që lexuesit i shohin në faqen e saj."',
    );
    expect(wording).toContain('photoLabel: "Logoja (JPEG ose PNG, deri në 5 MB)"');
    expect(wording).toContain("deleteLabel: null");
  });

  it("k1: no link to the house page until build 2b", () => {
    expect(card).toContain('{used && kind !== "house" && (');
    expect(card).not.toContain("Shikoni faqen e shtëpisë botuese");
  });
});
