import { describe, expect, it } from "vitest";
import { RIGHTS_BASES, RIGHTS_STATEMENT_VERSION, RIGHTS_STATEMENTS, isRightsBasis } from "./rights-statements";

const codePoints = (text: string) => Array.from(text, (ch) => ch.codePointAt(0));

describe("RIGHTS_STATEMENTS", () => {
  // ALBANIAN-9 (Renato 10-28 "2. b"): rights-v2 is the Albanian wording.
  it("own_rights is the Albanian sentence, code point for code point (no full stop)", () => {
    expect(codePoints(RIGHTS_STATEMENTS.own_rights.text)).toEqual(
      codePoints(
        "Unë i zotëroj të drejtat e këtij libri, ose kam lejen e mbajtësit të të drejtave për ta botuar dhe shitur",
      ),
    );
  });

  it("public_domain is the Albanian sentence, code point for code point (no full stop)", () => {
    expect(codePoints(RIGHTS_STATEMENTS.public_domain.text)).toEqual(
      codePoints("Ky libër është në domenin publik, përfshirë çdo përkthim që ngarkoj"),
    );
  });

  it("public_domain_original is the Albanian sentence, code point for code point (no full stop)", () => {
    expect(codePoints(RIGHTS_STATEMENTS.public_domain_original.text)).toEqual(
      codePoints(
        "Vepra origjinale është në domenin publik; përkthimi është imi ose kam lejen e përkthyesit për ta botuar dhe shitur",
      ),
    );
  });

  it("every sentence is NFC (ë and ç as single code points), with no trailing full stop or space", () => {
    for (const basis of RIGHTS_BASES) {
      const text = RIGHTS_STATEMENTS[basis].text;
      expect(text).toBe(text.normalize("NFC"));
      expect(codePoints(text).every((cp) => cp !== undefined && cp >= 0x20 && cp !== 0x7f)).toBe(true);
      expect(text).not.toMatch(/[.\s]$/);
      expect(text).toBe(text.trim());
    }
  });

  it("the version is rights-v2 and the bases are exactly the three the database accepts", () => {
    expect(RIGHTS_STATEMENT_VERSION).toBe("rights-v2");
    expect([...RIGHTS_BASES]).toEqual(["own_rights", "public_domain", "public_domain_original"]);
    expect(Object.keys(RIGHTS_STATEMENTS).sort()).toEqual(["own_rights", "public_domain", "public_domain_original"]);
  });

  it("isRightsBasis accepts only the three keys", () => {
    expect(isRightsBasis("own_rights")).toBe(true);
    expect(isRightsBasis("public_domain")).toBe(true);
    expect(isRightsBasis("public_domain_original")).toBe(true);
    for (const value of ["", "Own_rights", "own_rights ", RIGHTS_STATEMENTS.own_rights.text, null, undefined, 1, {}]) {
      expect(isRightsBasis(value)).toBe(false);
    }
  });
});
