import { describe, expect, it } from "vitest";
import { mapCategoryRpcError, readCategoryFields } from "./category-logic";

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}
const GOOD = { label: " Përkthime ", shortLabel: "Përkthime", description: "D", urlSlug: "perkthime", colour: "teal", cta: "publish" };

describe("readCategoryFields", () => {
  it("a good new category, trimmed", () => {
    expect(readCategoryFields(form(GOOD), "new")).toEqual({
      ok: true,
      value: { label: "Përkthime", shortLabel: "Përkthime", description: "D", urlSlug: "perkthime", colour: "teal", cta: "publish" },
    });
  });

  it("length and choice rules", () => {
    expect(readCategoryFields(form({ ...GOOD, label: " " }), "new")).toMatchObject({ ok: false });
    expect(readCategoryFields(form({ ...GOOD, shortLabel: "s".repeat(25) }), "new")).toMatchObject({ ok: false });
    expect(readCategoryFields(form({ ...GOOD, description: "d".repeat(201) }), "new")).toMatchObject({ ok: false });
    expect(readCategoryFields(form({ ...GOOD, colour: "gold" }), "new")).toMatchObject({ ok: false });
    expect(readCategoryFields(form({ ...GOOD, cta: "shop" }), "new")).toMatchObject({ ok: false });
    for (const bad of ["Përkthime", "a--b", "-a", "a b", "", "a".repeat(61)]) {
      expect(readCategoryFields(form({ ...GOOD, urlSlug: bad }), "new")).toMatchObject({ ok: false });
    }
  });

  it("edit ignores the address (fixed); Editorial reads the three texts only", () => {
    expect(readCategoryFields(form({ ...GOOD, urlSlug: "" }), "edit")).toMatchObject({ ok: true });
    expect(readCategoryFields(form({ label: "E", shortLabel: "E", description: "D" }), "editorial")).toMatchObject({
      ok: true,
      value: { label: "E", colour: "gold", cta: "browse" },
    });
  });
});

describe("mapCategoryRpcError", () => {
  it("known messages, unique violation, and a safe fallback", () => {
    expect(mapCategoryRpcError({ message: "choose where its articles move" })).toBe("Choose another category for its articles.");
    expect(mapCategoryRpcError({ message: "x", code: "23505" })).toBe("That address is already used by another category. Pick another.");
    expect(mapCategoryRpcError({ message: "boom" })).toBe("Something went wrong. Please try again.");
  });
});
