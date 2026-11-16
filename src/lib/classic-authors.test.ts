import { describe, expect, it, vi } from "vitest";
import {
  formatClassicLifeLine,
  formatClassicYears,
  loadClassicAuthorsByWork,
  mapClassicAuthorRpcError,
  normalizeClassicBio,
  validateClassicAuthorForm,
} from "@/lib/classic-authors";
import { PAGE_ERROR_MESSAGES } from "@/lib/page-messages";

// K6 free Albanian classics: the helpers behind the shelf, the book
// page, the classic page and the staff form.

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const GOOD = {
  name: "Naim Frashëri", slug: "", birthYear: "1846", deathYear: "1900",
  birthPlace: " Frashër ", deathPlace: "", bio: "Poet.\r\n\r\n\r\nRilindas.  ",
};

describe("formatting", () => {
  it("years with word joiners around the dash", () => {
    expect(formatClassicYears({ birth_year: 1846, death_year: 1900 })).toBe("1846⁠–⁠1900");
  });
  it("the life line, with and without places", () => {
    expect(formatClassicLifeLine({ birth_year: 1846, death_year: 1900, birth_place: "Frashër", death_place: "Stamboll" })).toBe(
      "Lindi në Frashër, 1846 · Vdiq në Stamboll, 1900",
    );
    expect(formatClassicLifeLine({ birth_year: 1911, death_year: 1938, birth_place: null, death_place: "Torino" })).toBe(
      "Lindi më 1911 · Vdiq në Torino, 1938",
    );
  });
  it("the bio keeps paragraphs, drops tabs and invisible characters", () => {
    expect(normalizeClassicBio(" A\tb​ \r\n\r\n\r\n\r\n c ")).toBe("Ab\n\nc");
  });
});

describe("validateClassicAuthorForm", () => {
  it("a good form, the slug made from the name (ë and ç too)", () => {
    const result = validateClassicAuthorForm(form(GOOD), 2026);
    expect(result).toEqual({
      ok: true,
      value: {
        id: null, slug: "naim-frasheri", name: "Naim Frashëri", birthYear: 1846, deathYear: 1900,
        birthPlace: "Frashër", deathPlace: null, bio: "Poet.\n\nRilindas.",
      },
    });
  });

  it("the 70-year rule: this year minus 71 is allowed, minus 70 is not", () => {
    expect(validateClassicAuthorForm(form({ ...GOOD, deathYear: "1955" }), 2026).ok).toBe(true);
    expect(validateClassicAuthorForm(form({ ...GOOD, deathYear: "1956" }), 2026)).toEqual({
      ok: false, error: "Only authors who died more than 70 years ago can be added.",
    });
  });

  it("refuses bad fields, each with a message the page will show", () => {
    const bad: Record<string, string>[] = [
      { ...GOOD, id: "not-a-uuid" },
      { ...GOOD, name: "  " },
      { ...GOOD, name: "x".repeat(201) },
      { ...GOOD, slug: "Bad Slug" },
      { ...GOOD, slug: "a--b" },
      { ...GOOD, birthYear: "18x6" },
      { ...GOOD, deathYear: "" },
      { ...GOOD, birthYear: "1901" },
      { ...GOOD, birthPlace: "x".repeat(121) },
      { ...GOOD, bio: " \n " },
      { ...GOOD, bio: "x".repeat(3001) },
    ];
    for (const fields of bad) {
      const result = validateClassicAuthorForm(form(fields), 2026);
      expect(result.ok, JSON.stringify(fields).slice(0, 80)).toBe(false);
      if (!result.ok) expect(PAGE_ERROR_MESSAGES.has(result.error), result.error).toBe(true);
    }
  });

  it("maps every database refusal to a listed message", () => {
    for (const code of ["23505", "LB515", "LB516", "LB517", "XX000", null]) {
      expect(PAGE_ERROR_MESSAGES.has(mapClassicAuthorRpcError({ code })), String(code)).toBe(true);
    }
  });
});

describe("loadClassicAuthorsByWork", () => {
  it("asks nothing for no work ids", async () => {
    const from = vi.fn();
    expect((await loadClassicAuthorsByWork({ from } as never, [null, undefined])).size).toBe(0);
    expect(from).not.toHaveBeenCalled();
  });

  it("maps each live work to its author; an error gives an empty map", async () => {
    const author = { id: "a", slug: "a", name: "A", birth_year: 1, death_year: 2, birth_place: null, death_place: null, bio: "b", pd_work_ids: ["w1", "w2"] };
    let result: unknown = { data: [author], error: null };
    const overlaps = vi.fn(() => ({ returns: async () => result }));
    const supabase = { from: () => ({ select: () => ({ overlaps }) }) } as never;
    const map = await loadClassicAuthorsByWork(supabase, ["w1", "w1", "w3"]);
    expect(overlaps).toHaveBeenCalledWith("pd_work_ids", ["w1", "w3"]);
    expect(map.get("w1")).toBe(author);
    expect(map.get("w2")).toBe(author);
    expect(map.has("w3")).toBe(false);
    result = { data: null, error: { message: "boom" } };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await loadClassicAuthorsByWork(supabase, ["w1"])).size).toBe(0);
    quiet.mockRestore();
  });
});
