import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// BD15 P2: the Details tab renders every section, and the locks show.
vi.mock("@/app/(public)/dashboard/books/editor-actions", () => ({ createSeriesFromEditor: async () => ({ ok: false, message: "" }) }));

const { BookDetailsForm } = await import("./book-details-form");

const PEN = "d4444444-4444-4444-8444-444444444444";
const OTHER_PEN = "d5555555-5555-4555-8555-555555555555";

function render(
  overrides: Partial<Parameters<typeof BookDetailsForm>[0]["initial"]> = {},
  locked = false,
  liveProps: { rightsLocked?: boolean; live?: boolean } = {},
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
