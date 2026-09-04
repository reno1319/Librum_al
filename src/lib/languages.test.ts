import { describe, expect, it } from "vitest";
import { LANGUAGES, isSupportedLanguage, getLanguageLabel } from "./languages";

describe("LANGUAGES", () => {
  it("is exactly the launch set: sq, en, it", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["sq", "en", "it"]);
  });

  it("every entry has a non-empty human label", () => {
    for (const language of LANGUAGES) {
      expect(language.label.length).toBeGreaterThan(0);
    }
  });
});

describe("isSupportedLanguage", () => {
  it("accepts every launch code", () => {
    expect(isSupportedLanguage("sq")).toBe(true);
    expect(isSupportedLanguage("en")).toBe(true);
    expect(isSupportedLanguage("it")).toBe(true);
  });

  it("rejects an unsupported code", () => {
    expect(isSupportedLanguage("fr")).toBe(false);
    expect(isSupportedLanguage("de")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isSupportedLanguage("")).toBe(false);
  });

  it("is case-sensitive -- 'SQ' is not the same stable code as 'sq'", () => {
    expect(isSupportedLanguage("SQ")).toBe(false);
  });
});

describe("getLanguageLabel", () => {
  it("returns the human label for every launch code", () => {
    expect(getLanguageLabel("sq")).toBe("Albanian");
    expect(getLanguageLabel("en")).toBe("English");
    expect(getLanguageLabel("it")).toBe("Italian");
  });

  it("falls back to the raw code itself for an unrecognized value, never throwing", () => {
    expect(getLanguageLabel("fr")).toBe("fr");
    expect(getLanguageLabel("")).toBe("");
  });
});
