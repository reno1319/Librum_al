import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BookContentForm } from "./book-content-form";
import { coverRatioIsOff } from "./cover-field";

// BD15 P3: the Content tab renders every section of the mockup, the AI
// answer as stored, and the preview/download only once a file exists.

const BOOK = "c3333333-3333-4333-8333-333333333333";
const AUTHOR = "a1111111-1111-4111-8111-111111111111";

function render(o: { hasManuscript?: boolean; aiAnswer?: "yes" | "no" | null; aiUnreadable?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(BookContentForm, {
      action: async () => undefined,
      book: {
        id: BOOK,
        title: "Dimri në <Valbonë>",
        language: "sq",
        isbn: "978-3-16-148410-0",
        publisher: "Botime <X>",
        hasManuscript: o.hasManuscript ?? true,
        coverUrl: null,
      },
      authorId: AUTHOR,
      authorName: "Arta Kodra",
      aiAnswer: o.aiAnswer ?? null,
      aiUnreadable: o.aiUnreadable ?? false,
    }),
  );
}

describe("BookContentForm", () => {
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
