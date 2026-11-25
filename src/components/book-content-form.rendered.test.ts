import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookContentForm } from "./book-content-form";
import { coverRatioIsOff } from "./cover-field";

// BD15 P3: the Content tab renders every section of the mockup, the AI
// answer as stored, and the preview/download only once a file exists.

const BOOK = "c3333333-3333-4333-8333-333333333333";
const AUTHOR = "a1111111-1111-4111-8111-111111111111";

function render(
  o: { lbn?: string | null; hasManuscript?: boolean; aiAnswer?: "yes" | "no" | null; aiUnreadable?: boolean; markMissing?: string[]; earlierFiles?: { id: string; liveFrom: string; replacedAt: string; sizeBytes: number | null }[] } = {},
) {
  return renderToStaticMarkup(
    createElement(BookContentForm, {
      action: async () => undefined,
      book: {
        id: BOOK,
        title: "Dimri në <Valbonë>",
        language: "sq",
        isbn: "978-3-16-148410-0",
        lbn: o.lbn === undefined ? "LE7K4M9X2D" : o.lbn,
        publisher: "Botime <X>",
        hasManuscript: o.hasManuscript ?? true,
        coverUrl: null,
      },
      authorId: AUTHOR,
      authorName: "Arta Kodra",
      aiAnswer: o.aiAnswer ?? null,
      aiUnreadable: o.aiUnreadable ?? false,
      markMissing: o.markMissing,
      earlierFiles: o.earlierFiles,
    }),
  );
}

describe("BookContentForm", () => {
  // FV1 (fv2 a): the files buyers got before the current one.
  it("FV1: lists earlier files under the current manuscript, each with its own Shkarko link", () => {
    const html = render({
      earlierFiles: [
        { id: "77777777-7777-4777-8777-777777777771", liveFrom: "2026-11-02T10:00:00Z", replacedAt: "2026-11-20T10:00:00Z", sizeBytes: 1363149 },
        { id: "77777777-7777-4777-8777-777777777772", liveFrom: "2026-10-05T10:00:00Z", replacedAt: "2026-11-02T10:00:00Z", sizeBytes: 1258291 },
      ],
    });
    const current = html.indexOf("Dorëshkrimi aktual: skedar EPUB");
    const heading = html.indexOf(">Skedarët e mëparshëm<");
    expect(current).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(current);
    expect(html).toContain("Skedarët që lexuesit kanë marrë më parë. Lexuesit marrin gjithmonë skedarin aktual.");
    const first = html.indexOf("skedar EPUB · në shitje 2 nëntor 2026 – 20 nëntor 2026 · 1,3 MB");
    expect(first).toBeGreaterThan(heading);
    expect(html.indexOf("skedar EPUB · në shitje 5 tetor 2026 – 2 nëntor 2026 · 1,2 MB")).toBeGreaterThan(first);
    expect(html).toContain(`href="/api/books/${BOOK}/versions/77777777-7777-4777-8777-777777777771" download=""`);
    expect(html).toContain(`href="/api/books/${BOOK}/versions/77777777-7777-4777-8777-777777777772" download=""`);
  });

  it("FV1: no earlier file, no block", () => {
    expect(render()).not.toContain("Skedarët e mëparshëm");
    expect(render({ earlierFiles: [] })).not.toContain("Skedarët e mëparshëm");
  });

  it("shows the manuscript, cover, preview, AI and ISBN sections, the DRM line and both buttons", () => {
    const html = render();
    for (const text of [
      "Dorëshkrimi",
      ">Ballina</h2>",
      "Pamja paraprake",
      "A keni përdorur AI për të krijuar tekstin, përkthimin ose ballinën?",
      "Këtë përgjigje e sheh vetëm ekipi i Librum",
      "ISBN dhe botuesi",
      "pa DRM",
      "Ruaj draftin",
      "Ruaj dhe vazhdo",
      "1600 × 2560",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('name="manuscriptStoragePath"');
    expect(html).toContain('name="coverStoragePath"');
    expect(html).toContain('name="isbn"');
    expect(html).toContain('name="publisher"');
    // Text is escaped, never markup.
    expect(html).toContain("Botime &lt;X&gt;");
    expect(html).not.toContain("<X>");
  });

  // BD15 follow-up (walkthrough F5): Word (DOCX) is picked first, with its picker.
  it("picks DOCX first and shows the Word picker; EPUB is offered but not picked", () => {
    const html = render({ hasManuscript: false });
    const radios = html.match(/<label[^>]*><input type="radio"[^>]*>[\s\S]*?<\/label>/g) ?? [];
    const docx = radios.find((r) => r.includes(">DOCX</strong>"));
    const epub = radios.find((r) => r.includes(">EPUB</strong>"));
    expect(docx).toMatch(/<input type="radio"[^>]*checked=""/);
    expect(epub).toBeDefined();
    expect(epub).not.toMatch(/<input type="radio"[^>]*checked=""/);
    expect(html).toContain('accept=".docx,');
    expect(html).not.toContain('accept=".epub,');
  });

  it("D1: ballinë in the editor's own words, ju form, and a back link that saves first", () => {
    const html = render();
    expect(html).not.toMatch(/>Kopertina<\/h2>|A ke përdorur/);
    expect(html).toContain('value="back"');
    expect(html).toContain("Të dhënat</button>");
    expect(html).toContain("Hapi tjetër: Çmimi");
    // Phone: 44px fields with 16px text; computer: 34px with 14px.
    expect(html.match(/<input[^>]*name="publisher"[^>]*>/)![0]).toMatch(/h-11 text-base sm:h-\[34px\] sm:text-sm/);
    expect(html.match(/<input[^>]*name="isbn"[^>]*>/)![0]).toMatch(/h-11 text-base sm:h-\[34px\] sm:text-sm/);
  });

  it("offers the preview and the author's own download only when a file exists", () => {
    const withFile = render();
    expect(withFile).toContain("Hap pamjen paraprake");
    expect(withFile).toContain(`href="/api/books/${BOOK}/download"`);
    expect(withFile).toContain("Shkarko skedarin tim");
    const without = render({ hasManuscript: false });
    expect(without).not.toContain("Hap pamjen paraprake");
    expect(without).not.toContain("/download");
  });

  it("ticks the stored AI answer, and nothing when it is unanswered or unreadable", () => {
    const checked = (html: string) =>
      [...html.matchAll(/<input[^>]*name="aiUsed"[^>]*>/g)]
        .filter((m) => / checked=""/.test(m[0]))
        .map((m) => /value="(yes|no)"/.exec(m[0])?.[1])
        .join("|");
    expect(checked(render({ aiAnswer: "yes" }))).toBe("yes");
    expect(checked(render({ aiAnswer: "no" }))).toBe("no");
    expect(checked(render({ aiAnswer: null }))).toBe("");
    expect(checked(render({ aiAnswer: "yes", aiUnreadable: true }))).toBe("");
  });
});

describe("BookContentForm: LBN (pictures lbnp1 a)", () => {
  it("shows the LBN read-only under the ISBN, with the locked note, and sends no lbn field", () => {
    const html = render();
    const isbnAt = html.indexOf('name="isbn"');
    const lbnAt = html.indexOf(">LBN</span>");
    const publisherAt = html.indexOf('name="publisher"');
    expect(isbnAt).toBeGreaterThan(-1);
    expect(lbnAt).toBeGreaterThan(isbnAt);
    expect(publisherAt).toBeGreaterThan(lbnAt);
    expect(html).toContain(">LE7K4M9X2D</p>");
    expect(html).toContain("🔒 Kodi i librit në Librum. Librum e jep vetë dhe nuk ndryshon kurrë.");
    expect(html).not.toMatch(/name="lbn"/);
  });

  it("shows no LBN line when the read had none", () => {
    const html = render({ lbn: null });
    expect(html).not.toContain(">LBN</span>");
    expect(html).not.toContain("Kodi i librit në Librum");
  });
});

describe("coverRatioIsOff (a warning, never a block)", () => {
  it("accepts shapes near 1 : 1.6 and flags the rest", () => {
    expect(coverRatioIsOff(1600, 2560)).toBe(false);
    expect(coverRatioIsOff(1000, 1500)).toBe(false);
    expect(coverRatioIsOff(1000, 1800)).toBe(false);
    expect(coverRatioIsOff(1000, 1000)).toBe(true);
    expect(coverRatioIsOff(1000, 2000)).toBe(true);
    expect(coverRatioIsOff(0, 100)).toBe(false);
  });
});

// Upload notes 1 and 2 (Enkelejd 11-06).
describe("BookContentForm: upload notes", () => {
  const section = (html: string, id: string) => html.match(new RegExp(`<section aria-labelledby="${id}"[^>]*>`))![0];

  it("carries the unsaved-changes guard inside the form", () => {
    expect(render()).toMatch(/^<form[^>]*><span hidden="">/);
  });

  it("opened from the to-do list: each missing box is outlined red with a message", () => {
    const html = render({ markMissing: ["Ballina", "Pyetja për AI"] });
    expect(section(html, "content-cover")).toContain("border-red-700");
    expect(section(html, "content-ai")).toContain("border-red-700");
    expect(section(html, "content-manuscript")).not.toContain("border-red-700");
    expect(html.split("Plotësojeni këtë para se ta dërgoni.").length - 1).toBe(2);
  });

  it("without the flag nothing is red", () => {
    const html = render();
    expect(html).not.toContain("border-red-700");
    expect(html).not.toContain("Plotësojeni këtë para se ta dërgoni.");
  });
});
