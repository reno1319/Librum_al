import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P2: the Details tab renders every section, and the locks show.
vi.mock("@/app/(public)/dashboard/books/editor-actions", () => ({ createSeriesFromEditor: async () => ({ ok: false, message: "" }) }));

const { BookDetailsForm } = await import("./book-details-form");

const PEN = "d4444444-4444-4444-8444-444444444444";
const OTHER_PEN = "d5555555-5555-4555-8555-555555555555";

function render(overrides: Partial<Parameters<typeof BookDetailsForm>[0]["initial"]> = {}, locked = false) {
  return renderToStaticMarkup(
    createElement(BookDetailsForm, {
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

describe("BookDetailsForm", () => {
  it("renders the sections of the Details tab and the two save buttons", () => {
    const html = render();
    for (const heading of ["Gjuha", "Titulli", "Autori", "Seria", "Botimi", "Përshkrimi", "Të drejtat", "Lexuesit", "Kategoritë", "Fjalët kyçe"]) {
      expect(html).toContain(`>${heading}</h2>`);
    }
    expect(html).toContain('value="save"');
    expect(html).toContain("Ruaj draftin");
    expect(html).toContain('value="next"');
    expect(html).toContain("Ruaj dhe vazhdo →");
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
    expect(html).toMatch(/<input type="checkbox" disabled=""\/>Për fëmijë/);
  });

  it("shows the title and pen name as locked once the book was published", () => {
    const html = render({}, true);
    expect(html).toContain("🔒 Titulli nuk ndryshohet pasi libri publikohet.");
    expect(html).toContain("🔒 Emri i autorit nuk ndryshohet pasi libri publikohet.");
    expect(html).not.toMatch(/<input[^>]*name="title"[^>]*type="text"/);
    expect(html).not.toContain('name="penNameId"');
  });

  it("an unlocked draft can change both, and says the title will lock", () => {
    const html = render();
    expect(html).toMatch(/<input[^>]*name="title"/);
    expect(html).toContain('name="penNameId"');
    expect(html).toContain("Pas publikimit titulli nuk mund të ndryshohet më.");
  });
});
