import { describe, expect, it } from "vitest";
import {
  FORM_DRAFT_MAX_AGE_MS,
  applyFormDraft,
  parseFormDraft,
  serializeFormDraft,
  type DraftField,
} from "./form-draft";

const NOW = 1_800_000_000_000;
const FIELDS = ["title", "description", "genre", "price", "manuscriptTempPath", "cover", "dup"] as const;

function makeForm() {
  const fields: Record<string, unknown> = {
    title: { tagName: "INPUT", type: "text", value: "Typed title" } satisfies DraftField,
    description: { tagName: "TEXTAREA", value: "Typed description" } satisfies DraftField,
    genre: {
      tagName: "SELECT",
      value: "Fiction",
      options: [{ value: "" }, { value: "Fiction" }, { value: "Poetry" }],
    } satisfies DraftField,
    price: { tagName: "input", value: "990" } satisfies DraftField,
    manuscriptTempPath: { tagName: "INPUT", type: "hidden", value: "u/tmp/abc.epub" } satisfies DraftField,
    cover: { tagName: "INPUT", type: "file", value: "C:\\fakepath\\c.png" } satisfies DraftField,
    // Several controls sharing a name come back as a RadioNodeList.
    dup: { length: 2, value: "x" },
    notListed: { tagName: "INPUT", type: "text", value: "secret" } satisfies DraftField,
  };
  return { fields, form: { elements: { namedItem: (name: string) => fields[name] ?? null } } };
}

describe("form drafts", () => {
  it("keeps only listed text, textarea and select fields -- never hidden, file or grouped controls", () => {
    const { form } = makeForm();
    const raw = serializeFormDraft(form, FIELDS, NOW);
    expect(JSON.parse(raw)).toEqual({
      savedAt: NOW,
      values: { title: "Typed title", description: "Typed description", genre: "Fiction", price: "990" },
    });
    expect(raw).not.toContain("tmp");
    expect(raw).not.toContain("secret");
  });

  it("round-trips the typed values back into a freshly rendered form", () => {
    const typed = makeForm();
    const raw = serializeFormDraft(typed.form, FIELDS, NOW);

    const fresh = makeForm();
    (fresh.fields.title as DraftField).value = "DB title";
    (fresh.fields.description as DraftField).value = "DB description";
    (fresh.fields.genre as DraftField).value = "Poetry";
    (fresh.fields.manuscriptTempPath as DraftField).value = "";

    const values = parseFormDraft(raw, FIELDS, NOW + 1000);
    expect(values).not.toBeNull();
    expect(applyFormDraft(fresh.form, values!, FIELDS)).toBe(3);
    expect((fresh.fields.title as DraftField).value).toBe("Typed title");
    expect((fresh.fields.description as DraftField).value).toBe("Typed description");
    expect((fresh.fields.genre as DraftField).value).toBe("Fiction");
    expect((fresh.fields.manuscriptTempPath as DraftField).value).toBe("");
  });

  it("never writes a hidden or file input, an unlisted name, or a select value with no matching option", () => {
    const { fields, form } = makeForm();
    const changed = applyFormDraft(
      form,
      {
        manuscriptTempPath: "attacker/tmp/x.epub",
        cover: "x",
        notListed: "changed",
        genre: "Not a genre",
      },
      [...FIELDS],
    );
    expect(changed).toBe(0);
    expect((fields.manuscriptTempPath as DraftField).value).toBe("u/tmp/abc.epub");
    expect((fields.notListed as DraftField).value).toBe("secret");
    expect((fields.genre as DraftField).value).toBe("Fiction");
  });

  it("ignores stale, future-dated, malformed or wrongly shaped copies", () => {
    const ok = JSON.stringify({ savedAt: NOW, values: { title: "t" } });
    expect(parseFormDraft(ok, FIELDS, NOW + FORM_DRAFT_MAX_AGE_MS)).toEqual({ title: "t" });
    expect(parseFormDraft(ok, FIELDS, NOW + FORM_DRAFT_MAX_AGE_MS + 1)).toBeNull();
    expect(parseFormDraft(ok, FIELDS, NOW - 1)).toBeNull();
    for (const raw of [
      null,
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ savedAt: "now", values: {} }),
      JSON.stringify({ savedAt: NOW, values: [] }),
      JSON.stringify({ savedAt: NOW }),
    ]) {
      expect(parseFormDraft(raw, FIELDS, NOW)).toBeNull();
    }
  });

  it("drops unlisted names and non-string values from a stored copy", () => {
    const raw = JSON.stringify({
      savedAt: NOW,
      values: { title: 5, description: "ok", other: "x", __proto__: { genre: "Poetry" } },
    });
    expect(parseFormDraft(raw, FIELDS, NOW)).toEqual({ description: "ok" });
  });
});
