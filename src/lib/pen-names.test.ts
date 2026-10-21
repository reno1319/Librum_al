import { describe, expect, it } from "vitest";
import {
  PEN_NAME_LOCKED_MESSAGE,
  PEN_NAME_MIXED_MESSAGE,
  PEN_NAME_TAKEN_MESSAGE,
  authorPagePath,
  isAllowedPenNameLink,
  parsePenNameLinks,
  parsePenNameName,
  penNameErrorMessage,
  penNameLinkLabel,
  readPenNameLinks,
} from "./pen-names";
import { canonicalPenNamePhotoPath, isPenNamePhotoPath } from "./pen-name-photo-path";

// PEN-NAMES-1: the pure helpers behind the Author Page, the Pen names form
// and the database's own refusals.

describe("authorPagePath", () => {
  it("is /authors/<pen name id>", () => {
    expect(authorPagePath("bbbbbbbb-0000-4000-8000-00000000000a")).toBe("/authors/bbbbbbbb-0000-4000-8000-00000000000a");
  });
});

describe("links (8a: up to 3, https only)", () => {
  it.each([
    ["https://example.com", true],
    ["https://example.com/a?b=c#d", true],
    ["http://example.com", false],
    ["javascript:alert(1)", false],
    ["https://", false],
    ["https://user:pass@example.com", false],
    ["https://exa mple.com", false],
    ["ftp://example.com", false],
    ["", false],
    [`https://example.com/${"a".repeat(500)}`, false],
  ])("%s -> %s", (value, ok) => {
    expect(isAllowedPenNameLink(value)).toBe(ok);
  });

  it("readPenNameLinks keeps only valid https strings, at most 3, from any stored value", () => {
    expect(readPenNameLinks(null)).toEqual([]);
    expect(readPenNameLinks("https://example.com")).toEqual([]);
    expect(readPenNameLinks([1, "javascript:x", "https://a.example", "https://b.example", "https://c.example", "https://d.example"])).toEqual([
      "https://a.example",
      "https://b.example",
      "https://c.example",
    ]);
  });

  it("parsePenNameLinks drops empty boxes and refuses more than 3, non-https, or repeats", () => {
    expect(parsePenNameLinks(["", " https://a.example ", "  "])).toEqual({ ok: true, links: ["https://a.example"] });
    expect(parsePenNameLinks(["https://a.example", "https://b.example", "https://c.example", "https://d.example"]).ok).toBe(false);
    expect(parsePenNameLinks(["http://a.example"]).ok).toBe(false);
    expect(parsePenNameLinks(["https://a.example", "https://a.example"]).ok).toBe(false);
    expect(parsePenNameLinks([new File([], "x")])).toEqual({ ok: true, links: [] });
  });

  it("a link's label is host and path, without the scheme", () => {
    expect(penNameLinkLabel("https://example.com/")).toBe("example.com");
    expect(penNameLinkLabel("https://example.com/jo")).toBe("example.com/jo");
  });
});

describe("parsePenNameName", () => {
  it("trims, refuses empty and more than 120 characters", () => {
    expect(parsePenNameName("  Jo Pen ")).toEqual({ ok: true, name: "Jo Pen" });
    expect(parsePenNameName("   ").ok).toBe(false);
    expect(parsePenNameName(null).ok).toBe(false);
    expect(parsePenNameName("x".repeat(120)).ok).toBe(true);
    expect(parsePenNameName("x".repeat(121)).ok).toBe(false);
  });
});

describe("penNameErrorMessage", () => {
  it("maps the migration's SQLSTATEs to clear messages, nothing else", () => {
    expect(penNameErrorMessage({ code: "LB451" })).toBe(PEN_NAME_MIXED_MESSAGE);
    expect(penNameErrorMessage({ code: "LB452" })).toBe(PEN_NAME_LOCKED_MESSAGE);
    expect(penNameErrorMessage({ code: "LB453" })).toBe(PEN_NAME_TAKEN_MESSAGE);
    expect(penNameErrorMessage({ code: "23505" })).toBeNull();
    expect(penNameErrorMessage({ code: "23514" })).toBeNull();
    expect(penNameErrorMessage(null)).toBeNull();
  });
});

describe("pen name photo path (9a: never the account id)", () => {
  const FOLDER = "cccccccc-0000-4000-8000-000000000001";

  it("is <random folder>/pen-name.<jpg|png>", () => {
    expect(canonicalPenNamePhotoPath(FOLDER, "jpg")).toBe(`${FOLDER}/pen-name.jpg`);
    expect(canonicalPenNamePhotoPath(FOLDER, "png")).toBe(`${FOLDER}/pen-name.png`);
    expect(() => canonicalPenNamePhotoPath("../x", "png")).toThrow();
    expect(() => canonicalPenNamePhotoPath(FOLDER, "gif" as "png")).toThrow();
  });

  it.each([
    [`${FOLDER}/pen-name.jpg`, true],
    [`${FOLDER}/pen-name.png`, true],
    [`${FOLDER}/avatar.png`, false],
    [`${FOLDER.toUpperCase()}/pen-name.png`, false],
    [`${FOLDER}/../x/pen-name.png`, false],
    [`x/${FOLDER}/pen-name.png`, false],
    [`${FOLDER}/pen-name.jpeg`, false],
    [null, false],
  ])("%s -> %s (same shape as pen_names_avatar_path_check)", (value, ok) => {
    expect(isPenNamePhotoPath(value)).toBe(ok);
  });
});
