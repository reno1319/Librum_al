import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// BUILD 2a-2 (approved picture 7): a publishing house's Autorët tab.
// Source-level, like the Profili page test.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
const card = readFileSync(path.join(__dirname, "..", "profile", "pen-name-card.tsx"), "utf8");

describe("Dashboard Autorët (publishing houses only)", () => {
  it("is for houses only: anyone else goes to Profili", () => {
    expect(source).toContain('.select("account_kind")');
    expect(source).toContain('if (profile?.account_kind !== "publishing_house") {\n    redirect("/dashboard/profile");');
    expect(source).toContain('redirect("/login?next=/dashboard/authors")');
  });

  it("has the approved title and text", () => {
    expect(source).toContain('title: "Autorët"');
    expect(source).toContain('title="Autorët"');
    expect(source).toContain(
      "Shtoni sa autorë të doni. Çdo autor ka faqen e vet me librat e tij. Lexuesit shohin biografinë, foton ose lidhjet vetëm nëse i shtoni.",
    );
  });

  it("lists only the house's own non-default pen names", () => {
    expect(source).toContain('.eq("author_id", user.id)\n      .eq("is_default", false)');
  });

  it("'+ Shto autor' opens a name box that reuses createPenName and comes back to Autorët", () => {
    const box = source.slice(source.indexOf("<details"), source.indexOf("</details>"));
    expect(box).toContain("+ Shto autor");
    expect(box).toContain("action={createPenName}");
    expect(box).toContain("Emri i autorit");
    expect(box).toMatch(/name="name"[^>]*required/);
    expect(box).toContain('<input type="hidden" name={FROM_AUTHORS_FIELD} value={FROM_AUTHORS_VALUE} />');
  });

  it("each author is build 1's card with author wording; 'Hiqni autorin' only when unused; no 'Kryesori'", () => {
    expect(source).toContain('kind="houseAuthor"');
    const wording = card.slice(card.indexOf("  houseAuthor: {"), card.indexOf("};", card.indexOf("  houseAuthor: {")));
    expect(wording).toContain('nameLabel: "Emri"');
    expect(wording).toContain('bioPlaceholder: "Disa fjali që lexuesit i shohin në faqen e këtij autori."');
    expect(wording).toContain('deleteLabel: "Hiqni autorin"');
    expect(card).toContain("{wording.deleteLabel && !isMain && !used && (");
    expect(source + card).not.toContain("Kryesori");
    // Both the save and the remove form send from=authors.
    expect(card).toContain('kind === "houseAuthor" ? <input type="hidden" name={FROM_AUTHORS_FIELD} value={FROM_AUTHORS_VALUE} />');
    expect(card.match(/\{fromAuthors\}/g)).toHaveLength(2);
    expect(card).toContain('export const FROM_AUTHORS_VALUE = "authors";');
  });
});
