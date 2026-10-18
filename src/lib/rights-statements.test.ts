import { describe, expect, it } from "vitest";
import { RIGHTS_BASES, RIGHTS_STATEMENT_VERSION, RIGHTS_STATEMENTS, isRightsBasis } from "./rights-statements";

const codePoints = (text: string) => Array.from(text, (ch) => ch.codePointAt(0));

describe("RIGHTS_STATEMENTS", () => {
  it("own_rights is Renato's sentence, code point for code point (straight apostrophe, no full stop)", () => {
    const expected =
      "I own the rights to this book, or I have the rights holder" + String.fromCodePoint(0x27) +
      "s permission to publish and sell it";
    expect(codePoints(RIGHTS_STATEMENTS.own_rights.text)).toEqual(codePoints(expected));
    expect(RIGHTS_STATEMENTS.own_rights.text.length).toBe(94);
    expect(codePoints(RIGHTS_STATEMENTS.own_rights.text).filter((cp) => cp === 0x27)).toHaveLength(1);
  });

  it("public_domain is Renato's sentence, code point for code point (no full stop)", () => {
    expect(codePoints(RIGHTS_STATEMENTS.public_domain.text)).toEqual(
      codePoints("This book is in the public domain, including any translation I upload"),
    );
    expect(RIGHTS_STATEMENTS.public_domain.text.length).toBe(69);
  });

  it("both sentences are plain ASCII: no curly quotes, no trailing full stop or space", () => {
    for (const basis of RIGHTS_BASES) {
      const text = RIGHTS_STATEMENTS[basis].text;
      expect(codePoints(text).every((cp) => cp !== undefined && cp >= 0x20 && cp < 0x7f)).toBe(true);
      expect(text).not.toMatch(/[.\s]$/);
      expect(text).toBe(text.trim());
    }
  });

  it("the version is rights-v1 and the bases are exactly the two the database accepts", () => {
    expect(RIGHTS_STATEMENT_VERSION).toBe("rights-v1");
    expect([...RIGHTS_BASES]).toEqual(["own_rights", "public_domain"]);
    expect(Object.keys(RIGHTS_STATEMENTS).sort()).toEqual(["own_rights", "public_domain"]);
  });

  it("isRightsBasis accepts only the two keys", () => {
    expect(isRightsBasis("own_rights")).toBe(true);
    expect(isRightsBasis("public_domain")).toBe(true);
    for (const value of ["", "Own_rights", "own_rights ", RIGHTS_STATEMENTS.own_rights.text, null, undefined, 1, {}]) {
      expect(isRightsBasis(value)).toBe(false);
    }
  });
});
