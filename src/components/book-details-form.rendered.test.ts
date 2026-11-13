import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P2: the Details tab renders every section, and the locks show.
vi.mock("@/app/(public)/dashboard/books/editor-actions", () => ({ createSeriesFromEditor: async () => ({ ok: false, message: "" }) }));
// Upload notes 1: the form re-reads the pen names when the author comes back.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const { BookDetailsForm, detailsExtrasInUse, isExtrasField } = await import("./book-details-form");

const PEN = "d4444444-4444-4444-8444-444444444444";
const OTHER_PEN = "d5555555-5555-4555-8555-555555555555";

function render(
  overrides: Partial<Parameters<typeof BookDetailsForm>[0]["initial"]> = {},
  locked = false,
  liveProps: { rightsLocked?: boolean; live?: boolean; pdFrozen?: boolean; markMissing?: ("title" | "bookType" | "categories" | "description" | "rightsBasis" | "originalAuthor")[] } = {},
) {
  return renderToStaticMarkup(
    createElement(BookDetailsForm, {
      ...liveProps,
      action: async () => undefined,
      initial: {
        title: "Dimri në <Valbonë>",
        subtitle: "",
        language: "sq",
        seriesId: "",
        seriesPosition: "",
        editionNumber: "",
        penNameId: PEN,
        description: "**Hyrje** <script>alert(1)</script>",
        isAdult: false,
        readingAge: "",
        bookType: "",
        categories: ["Poezi", "Histori"],
        keywords: "a, b",
        contributors: [{ id: "c1", name: "Besnik", role: "Editor" }],
        rightsBasis: "",
        originalAuthor: "",
        ...overrides,
      },
      locked,
      lockedPenName: locked ? "Arta Kodra" : null,
      penNames: [
        { id: PEN, name: "Arta Kodra", is_default: true },
        { id: OTHER_PEN, name: "A. K.", is_default: false },
      ],
      series: [
        { id: "s1", title: "Kronikat", pen_name_id: PEN },
        { id: "s2", title: "Seria tjetër", pen_name_id: OTHER_PEN },
      ],
    }),
  );
}

// DC 5 (Renato 11-13, a): series, edition and contributors live in one
// "Të dhëna shtesë (opsionale)" box at the end of the tab.
describe("BookDetailsForm: the extras box", () => {
  const extras = (html: string) => {
    const start = html.indexOf("<details");
    expect(start).toBeGreaterThan(-1);
    return { tag: html.slice(start, html.indexOf(">", start) + 1), body: html.slice(start, html.indexOf("</details>", start)) };
  };
  const blank = { seriesId: "", seriesPosition: "", editionNumber: "", contributors: [] };

  it("holds Seria, Botimi and Kontribues, after Fjalët kyçe and before the save buttons", () => {
    const html = render(blank);
    const { body } = extras(html);
    expect(body).toContain("Të dhëna shtesë");
    expect(body).toContain("(opsionale)");
    for (const name of ["seriesId", "seriesPosition", "editionNumber"]) expect(body).toContain(`name="${name}"`);
    expect(body).toContain("+ Shto kontribues");
    expect(html.indexOf(">Fjalët kyçe</h2>")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf('value="save"'));
    // Still inside the one <form>, so closed fields are saved as before.
    expect(html.indexOf("<details")).toBeGreaterThan(html.indexOf("<form"));
    expect(html.indexOf("</details>")).toBeLessThan(html.indexOf("</form>"));
  });

  it("starts closed for a book that uses none of them", () => {
    expect(extras(render(blank)).tag).not.toContain(" open");
    expect(extras(render({ ...blank, editionNumber: "1" })).tag).not.toContain(" open");
  });

  it("starts open when the book has a series, an edition above 1 or a contributor", () => {
    expect(extras(render({ ...blank, seriesId: "s1", seriesPosition: "2" })).tag).toContain(" open");
    expect(extras(render({ ...blank, editionNumber: "2" })).tag).toContain(" open");
    expect(extras(render({ ...blank, contributors: [{ id: "c1", name: "Besnik", role: "Editor" }] })).tag).toContain(" open");
  });

  it("names exactly its three fields as extras", () => {
    expect(["seriesPosition", "editionNumber", "contributors"].every((f) => isExtrasField(f as never))).toBe(true);
    for (const f of ["title", "subtitle", "language", "description", "keywords", "categories", "bookType", "rightsBasis"]) {
      expect(isExtrasField(f as never), f).toBe(false);
    }
    expect(detailsExtrasInUse({ seriesId: "", editionNumber: " 1 ", contributors: [] })).toBe(false);
    expect(detailsExtrasInUse({ seriesId: "", editionNumber: "3", contributors: [] })).toBe(true);
  });
});

describe("BookDetailsForm", () => {
  it("renders the sections of the Details tab and the two save buttons", () => {
    const html = render();
    for (const heading of ["Gjuha", "Titulli", "Autori", "Seria", "Botimi", "Përshkrimi", "Të drejtat", "Lexuesit", "Kategoritë", "Fjalët kyçe"]) {
      expect(html).toContain(`>${heading}</h2>`);
    }
    expect(html).toContain('value="save"');
    expect(html).toContain("Ruaj draftin");
    expect(html).toContain('value="next"');
    expect(html).toContain("Ruaj dhe vazhdo</button>");
    expect(html).toContain("Hapi tjetër: Përmbajtja");
    // The first tab has no back link.
    expect(html).not.toContain('value="back"');
    // D1b: the bar is not pinned to the screen (no tab pins it).
    expect(html).not.toContain("sticky");
  });

  it("escapes the stored description inside the editor box", () => {
    const html = render();
    expect(html).toContain("<strong>Hyrje</strong> &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("offers only the chosen pen name's series", () => {
    const html = render();
    expect(html).toContain("Kronikat");
    expect(html).not.toContain("Seria tjetër");
  });

  it("sends the categories in the order chosen, the first marked as the primary one", () => {
    const html = render();
    expect(html.indexOf('name="categories" value="Poezi"')).toBeLessThan(html.indexOf('name="categories" value="Histori"'));
    expect(html).toContain("2 nga 3 të zgjedhura");
    expect(html).toContain("(kryesore)");
  });

  it("18+ fixes the reading age at 18 and disables the children's categories", () => {
    const html = render({ isAdult: true, categories: [] });
    expect(html).toContain('<input type="hidden" name="readingAge" value="18"/>');
    expect(html).toMatch(/<input type="checkbox" disabled=""[^>]*\/>Për fëmijë/);
  });

  it("shows the title and pen name as locked once the book was published", () => {
    const html = render({}, true);
    expect(html).toContain("🔒 Titulli nuk ndryshohet pasi libri publikohet.");
    expect(html).toContain("🔒 Emri i autorit nuk ndryshohet pasi libri publikohet.");
    expect(html).not.toMatch(/<input[^>]*name="title"[^>]*type="text"/);
    expect(html).not.toContain('name="penNameId"');
  });

  it("D1: ballinë, bold labels with (opsional), and phone-sized fields", () => {
    const html = render();
    expect(html).toContain("Shkruajeni saktësisht si në ballinë.");
    expect(html).not.toContain("si në kopertinë");
    expect(html).toContain('Nëntitulli<span class="font-normal text-muted"> (opsional)</span>');
    expect(html.match(/<input[^>]*name="subtitle"[^>]*>/)![0]).toMatch(/h-11 text-base sm:h-\[34px\] sm:text-sm/);
  });

  it("an unlocked draft can change both, and says the title will lock", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*name="title"/);
    expect(html).toContain('name="penNameId"');
    expect(html).toContain("Pas publikimit titulli nuk mund të ndryshohet më.");
  });

  // BD15 P5b-2 (Renato 11-04, Q4 a): a live book's rights basis is fixed;
  // the fields that wait for review say so; the save button says what it does.
  it("a live book: the rights choice is shown but fixed, sent as stored; review hints; Ruani ndryshimet", () => {
    const html = render({ rightsBasis: "own_rights" }, true, { rightsLocked: true, live: true });
    const radios = html.match(/<input[^>]*type="radio"[^>]*value="(own_rights|public_domain)[^"]*"[^>]*>/g) ?? [];
    expect(radios.length).toBeGreaterThan(0);
    for (const radio of radios) {
      expect(radio).toContain("disabled");
      expect(radio).not.toContain('name="rightsBasis"');
    }
    expect(html).toContain('<input type="hidden" name="rightsBasis" value="own_rights"/>');
    expect(html).toContain("Të drejtat nuk ndryshohen sa libri është në shitje.");
    expect(html.split("Pret miratimin e Librum para se ta shohin lexuesit.").length - 1).toBe(3);
    expect(html).toContain("Ruani ndryshimet");
    expect(html).not.toContain("Ruaj draftin");
  });

  it("a draft: the rights choice is free, no review hints", () => {
    const html = render();
    expect(html).toContain('name="rightsBasis"');
    expect(html).not.toContain("Pret miratimin e Librum");
    expect(html).not.toContain("Të drejtat nuk ndryshohen sa libri është në shitje.");
  });
});

// BD15 follow-up (P7 audit N5): a picked public-domain edition's frozen
// fields are greyed (disabled), and the form still sends exactly what it
// sent before, so the server's pdFrozenDetailsUnchanged check passes.
// A small serializer of the static markup stands in for the browser's
// FormData (vitest runs without a DOM).
function decode(v: string): string {
  return v.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/\s([a-zA-Z-]+)(?:="([^"]*)")?/g)) out[m[1]] = decode(m[2] ?? "");
  return out;
}
function submitted(html: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const m of html.matchAll(/<input\b[^>]*>/g)) {
    const a = attrs(m[0]);
    if (!a.name || "disabled" in a) continue;
    if ((a.type === "radio" || a.type === "checkbox") && !("checked" in a)) continue;
    pairs.push([a.name, a.value ?? ""]);
  }
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
    const a = attrs(m[1]);
    if (!a.name || "disabled" in a) continue;
    const options = [...m[2].matchAll(/<option\b([^>]*)>/g)].map((o) => attrs(o[1]));
    const chosen = options.find((o) => "selected" in o) ?? options[0];
    pairs.push([a.name, chosen?.value ?? ""]);
  }
  return pairs;
}
const FROZEN_NAMES = [
  "language",
  "subtitle",
  "contributorId",
  "contributorRole",
  "contributorName",
  "seriesId",
  "seriesPosition",
  "editionNumber",
  "readingAge",
  "categories",
  "keywords",
];
const frozenPairs = (html: string) =>
  submitted(html)
    .filter(([name]) => FROZEN_NAMES.includes(name))
    .sort((x, y) => (x[0] + "\u0000" + x[1]).localeCompare(y[0] + "\u0000" + y[1]));

describe("BookDetailsForm: a picked public-domain edition (N5)", () => {
  const PICKED = {
    subtitle: "Botim i plotë",
    language: "en",
    seriesId: "s1",
    seriesPosition: "2",
    editionNumber: "3",
    readingAge: "12",
    keywords: "det, \"stuhi\"",
    rightsBasis: "public_domain" as const,
    originalAuthor: "Autor Prove",
  };
  const live = { rightsLocked: true, live: true };

  it("sends exactly the same frozen values as the unfrozen form", () => {
    const before = frozenPairs(render(PICKED, true, live));
    const after = frozenPairs(render(PICKED, true, { ...live, pdFrozen: true }));
    expect(before.length).toBeGreaterThan(8);
    expect(after).toEqual(before);
  });

  it("the same with 18+ on and no series: one reading age 18, no series number", () => {
    const values = { ...PICKED, isAdult: true, readingAge: "18", seriesId: "", seriesPosition: "" };
    const before = frozenPairs(render(values, true, live));
    const after = frozenPairs(render(values, true, { ...live, pdFrozen: true }));
    expect(after).toEqual(before);
    expect(after.filter(([n]) => n === "readingAge")).toEqual([["readingAge", "18"]]);
    expect(after.some(([n]) => n === "seriesPosition")).toBe(false);
  });

  it("every frozen control is greyed (disabled); the editable ones are not", () => {
    const html = render(PICKED, true, { ...live, pdFrozen: true });
    const visible = (name: string) =>
      [...html.matchAll(new RegExp(`<(input|select)\\b(?=[^>]*name="${name}")(?![^>]*type="hidden")[^>]*>`, "g"))].map((m) => m[0]);
    for (const name of ["language", "subtitle", "contributorRole", "contributorName", "seriesId", "seriesPosition", "editionNumber", "readingAge", "keywords"]) {
      const controls = visible(name);
      expect(controls.length, name).toBeGreaterThan(0);
      for (const c of controls) expect(c, name).toMatch(/\sdisabled=""/);
    }
    const categoryBoxes = html.match(/<input type="checkbox"[^>]*>/g) ?? [];
    expect(categoryBoxes.length).toBeGreaterThan(10);
    for (const box of categoryBoxes) expect(box).toContain('disabled=""');
    for (const name of ["originalAuthor", "isAdult"]) {
      for (const c of visible(name)) expect(c, name).not.toMatch(/\sdisabled=""/);
    }
    expect(html).not.toContain(">Hiq<");
    expect(html).not.toContain("+ Shto kontribues");
    expect(html).not.toContain("+ Krijo seri të re");
  });

  // Upload notes C: the type is frozen once set; with none it is free.
  it("a picked edition with a type sends it unchanged and greyed; with none it may choose", () => {
    const withType = { ...PICKED, bookType: "Poezi" };
    const before = submitted(render(withType, true, live)).filter(([n]) => n === "bookType");
    const html = render(withType, true, { ...live, pdFrozen: true });
    expect(submitted(html).filter(([n]) => n === "bookType")).toEqual(before);
    expect(before).toEqual([["bookType", "Poezi"]]);
    expect(html.match(/<select[^>]*name="bookType"[^>]*>/)![0]).toMatch(/\sdisabled=""/);
    const none = render({ ...PICKED, bookType: "" }, true, { ...live, pdFrozen: true });
    expect(none.match(/<select[^>]*name="bookType"[^>]*>/)![0]).not.toMatch(/\sdisabled=""/);
    expect(submitted(none).filter(([n]) => n === "bookType")).toEqual([["bookType", ""]]);
  });

  it("an ordinary live book is unchanged: nothing frozen, buttons there", () => {
    const html = render(PICKED, true, live);
    expect(html).not.toMatch(/name="subtitle"[^>]*disabled=""/);
    expect(html).toContain(">Hiq<");
    expect(html).toContain("+ Shto kontribues");
    expect(html).toContain("+ Krijo seri të re");
  });
});

// Upload notes 1 and 2 (Enkelejd 11-06).
describe("BookDetailsForm: upload notes", () => {
  it("the pen-name page opens in a new tab, and says so", () => {
    const link = render().match(/<a[^>]*href="\/dashboard\/pen-names"[^>]*>[\s\S]*?<\/a>/)![0];
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener"');
    expect(link).toContain("(hapet në një skedë të re)");
  });

  it("carries the unsaved-changes guard inside the form", () => {
    expect(render()).toMatch(/^<form[^>]*><span hidden="">/);
  });

  it("opened from the to-do list: the missing fields start red with a message", () => {
    const html = render({ title: "" }, false, { markMissing: ["title", "description", "rightsBasis"] });
    expect(html.match(/<input[^>]*name="title"[^>]*>/)![0]).toContain("border-red-700");
    expect(html).toContain('id="details-title-error"');
    expect(html).toContain('id="details-description-error"');
    expect(html).toContain('id="details-rightsBasis-error"');
    expect(html.split("Plotësojeni këtë para se ta dërgoni.").length - 1).toBe(3);
    expect(html).not.toContain('id="details-categories-error"');
  });

  // Upload notes C.
  it("Lloji i librit: one pick from the eight types, before the categories, and it can start red", () => {
    const html = render({ bookType: "Roman" });
    const select = html.match(/<select[^>]*name="bookType"[^>]*>([\s\S]*?)<\/select>/)!;
    const options = [...select[1].matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    expect(options).toEqual([
      "",
      "Roman",
      "Novelë / tregim",
      "Përmbledhje me tregime",
      "Poezi",
      "Dramë",
      "Ese",
      "Biografi &amp; kujtime",
      "Jo-artistik (studim, tjetër)",
    ]);
    expect(submitted(html).filter(([n]) => n === "bookType")).toEqual([["bookType", "Roman"]]);
    expect(html.indexOf("Lloji i librit")).toBeLessThan(html.indexOf("Kategoritë"));
    const red = render({ bookType: "" }, false, { markMissing: ["bookType"] });
    expect(red.match(/<select[^>]*name="bookType"[^>]*>/)![0]).toContain("border-red-700");
    expect(red).toContain('id="details-bookType-error"');
  });

  it("without the flag nothing is red", () => {
    const html = render({ title: "" });
    expect(html).not.toContain("Plotësojeni këtë para se ta dërgoni.");
    expect(html.match(/<input[^>]*name="title"[^>]*>/)![0]).not.toContain("border-red-700");
  });
});
