import { describe, expect, it } from "vitest";
import {
  BOOK_PEN_NAME_EMBED,
  resolveBookByline,
  resolveBookPenName,
  resolveOriginalAuthor,
  resolveTranslatorNames,
  resolveTranslatorLine,
  resolveStaffByline,
  normalizeOriginalAuthor,
} from "./book-byline";

// PEN-NAMES-1: the byline is the book's pen name, read through the
// public_pen_names view embed -- never an account column.
describe("resolveBookByline", () => {
  it("shows the embedded pen name", () => {
    expect(resolveBookByline({ pen: { id: "p1", name: "Ëngjëll Çela" } })).toBe("Ëngjëll Çela");
  });

  it("a missing embed is null, never an account name", () => {
    expect(resolveBookByline({ pen: null })).toBeNull();
    expect(resolveBookByline({})).toBeNull();
  });

  it("no book: null, never throws", () => {
    expect(resolveBookByline(null)).toBeNull();
    expect(resolveBookByline(undefined)).toBeNull();
  });

  it("the embed reads the view with no author_id", () => {
    expect(BOOK_PEN_NAME_EMBED).toBe("pen:public_pen_names(id, name)");
    expect(BOOK_PEN_NAME_EMBED).not.toMatch(/author/);
  });
});

// BD3 patch 4 (Renato 1 Nov, 1a 4a; 16:05Z 1a).
describe("the original author", () => {
  const pen = { id: "p1", name: "Botime Prova" };

  it("is the byline when set (cards show only it, 4a)", () => {
    expect(resolveBookByline({ pen, original_author: "Lev Tolstoi" })).toBe("Lev Tolstoi");
    expect(resolveOriginalAuthor({ pen, original_author: " Lev Tolstoi " })).toBe("Lev Tolstoi");
  });

  it("blank or missing falls back to the pen name", () => {
    for (const original_author of [null, undefined, "", "   "]) {
      expect(resolveBookByline({ pen, original_author })).toBe("Botime Prova");
      expect(resolveOriginalAuthor({ pen, original_author })).toBeNull();
    }
  });

  it("the pen name stays reachable for author pages and More by", () => {
    expect(resolveBookPenName({ pen, original_author: "Lev Tolstoi" })).toBe("Botime Prova");
    expect(resolveBookPenName(null)).toBeNull();
  });

  it("'Përktheu:' names the typed translators, else the pen name", () => {
    expect(resolveTranslatorNames(["Drita Shembull", " ", "Gëzim Prova "], "Botime Prova")).toBe(
      "Drita Shembull, Gëzim Prova",
    );
    expect(resolveTranslatorNames([], " Botime Prova ")).toBe("Botime Prova");
    expect(resolveTranslatorNames(["  "], "Botime Prova")).toBe("Botime Prova");
  });
});

// BD3 patch 4 r2 (audit r1: H1, N1, L1, M1; Renato 16:37Z 1a).
describe("patch 4 r2", () => {
  const pen = { id: "p1", name: "Botime Prova" };

  it("'Përktheu:' on a public_domain book names only typed translators, never the uploader (H1, 1a)", () => {
    expect(resolveTranslatorLine([], "Botime Prova", "public_domain")).toBeNull();
    expect(resolveTranslatorLine(["Drita Shembull"], "Botime Prova", "public_domain")).toBe("Drita Shembull");
  });

  it("the other bases (and no declaration) fall back to the pen name", () => {
    expect(resolveTranslatorLine([], "Botime Prova", "public_domain_original")).toBe("Botime Prova");
    expect(resolveTranslatorLine([], "Botime Prova", "own_rights")).toBe("Botime Prova");
    expect(resolveTranslatorLine([], "Botime Prova", null)).toBe("Botime Prova");
  });

  it("an unreadable basis never names the pen name; typed translators still show", () => {
    expect(resolveTranslatorLine([], "Botime Prova", null, false)).toBeNull();
    expect(resolveTranslatorLine([" Ana "], "Botime Prova", null, false)).toBe("Ana");
    expect(resolveTranslatorLine([], null, "own_rights")).toBeNull();
  });

  it("an original author equal to the pen name is none (N1)", () => {
    expect(resolveOriginalAuthor({ pen, original_author: " botime prova " })).toBeNull();
    expect(resolveBookByline({ pen, original_author: "BOTIME PROVA" })).toBe("Botime Prova");
  });

  it("staff see both names (M1)", () => {
    expect(resolveStaffByline({ pen, original_author: "Lev Tolstoi" })).toBe("Botime Prova · original author: Lev Tolstoi");
    expect(resolveStaffByline({ pen, original_author: null })).toBe("Botime Prova");
    expect(resolveStaffByline({ pen: null, original_author: "Lev Tolstoi" })).toBe("original author: Lev Tolstoi");
  });

  it("normalizeOriginalAuthor: whitespace runs become one space; controls and invisible format characters go (L1)", () => {
    expect(normalizeOriginalAuthor("  Lev Tolstoi  ")).toBe("Lev Tolstoi");
    expect(normalizeOriginalAuthor("Lev\t\n  Tolstoi")).toBe("Lev Tolstoi");
    expect(normalizeOriginalAuthor("Lev\u0000\u0085 Tol­stoi")).toBe("Lev Tolstoi");
    expect(normalizeOriginalAuthor("‮iotslot‬")).toBe("iotslot");
    expect(normalizeOriginalAuthor("​‍﻿")).toBe("");
    expect(normalizeOriginalAuthor("Gjergj Fishta, At")).toBe("Gjergj Fishta, At");
    expect(normalizeOriginalAuthor("Ëngjëll Çela")).toBe("Ëngjëll Çela");
  });
});
