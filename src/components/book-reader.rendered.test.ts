import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { BookReader, READER_TAP_CLASSES, closesOpenMenu, readSettings, type ReaderData } from "./book-reader";

// DD (13 Nov): every reader control is at least 44 px (size-11 / h-11 /
// min-h-11); Contents shows its word from tablet up, the page-look button
// stays icon-only.
const data: ReaderData = {
  title: "Libër prove",
  author: "Autor Prove",
  mode: "sample",
  html: "<section class=\"lb-sec\"><h1 id=\"c1\">1</h1><p>Tekst.</p></section>",
  toc: [{ id: "c1", label: "1. Kapitulli" }],
  approximatePercent: 10,
};

function render(devices = false) {
  return renderToStaticMarkup(
    createElement(BookReader, { data, coverUrl: null, onClose: () => {}, endAction: null, devices }),
  );
}

function tagWith(html: string, needle: string) {
  const tag = (html.match(/<(button|input)[^>]*>/g) ?? []).find((t) => t.includes(needle));
  expect(tag, needle).toBeDefined();
  return tag as string;
}

describe("BookReader tap sizes and labels (DD)", () => {
  it("top bar buttons are 44 px and keep their spoken names", () => {
    const html = render();
    expect(tagWith(html, 'aria-label="Mbyllni leximin"')).toMatch(/\bsize-11\b/);
    for (const label of ["Përmbajtja", "Madhësia e shkronjave dhe ngjyra e faqes"]) {
      const t = tagWith(html, `aria-label="${label}"`);
      expect(t).toMatch(/\bmin-h-11\b/);
      expect(t).toMatch(/\bmin-w-11\b/);
    }
    expect(html).not.toMatch(/\bsize-10\b/);
  });

  it("Contents shows its word from tablet width up; the page-look button has no word", () => {
    const html = render();
    expect(html).toMatch(/<span class="hidden text-sm sm:inline" aria-hidden="true">Përmbajtja<\/span>/);
    expect(html).not.toContain(">Pamja<");
  });

  it("the page slider is 44 px tall", () => {
    expect(tagWith(render(), 'type="range"')).toMatch(/\bh-11\b/);
  });

  it("the author's device buttons are 44 px", () => {
    const html = render(true);
    for (const label of ["Telefon", "Tablet", "Lexues elektronik"]) {
      const t = (html.match(/<button[^>]*role="radio"[^>]*>[^<]*/g) ?? []).find((b) => b.endsWith(label));
      expect(t, label).toBeDefined();
      expect(t).toMatch(/\bmin-h-11\b/);
    }
  });
});

describe("BookReader menu and end-page sizes (DD)", () => {
  it("chapter rows are 48 px, the letter-size buttons 44 px, the restart link 44 px", () => {
    expect(READER_TAP_CLASSES.tocRow).toMatch(/\bmin-h-12\b/);
    expect(READER_TAP_CLASSES.fontButton).toMatch(/\bh-11\b/);
    expect(READER_TAP_CLASSES.restart).toMatch(/\bmin-h-11\b/);
  });
});

describe("closesOpenMenu (DD Escape)", () => {
  it("Escape closes an open menu", () => {
    expect(closesOpenMenu("Escape", "toc", true)).toBe(true);
    expect(closesOpenMenu("Escape", "aa", true)).toBe(true);
  });
  it("with no menu open, Escape is left to the dialog (closes the reader)", () => {
    expect(closesOpenMenu("Escape", "none", true)).toBe(false);
  });
  it("after the popup is closed (X or Back) with a menu still open, Escape is left to the book page", () => {
    expect(closesOpenMenu("Escape", "aa", false)).toBe(false);
    expect(closesOpenMenu("Escape", "toc", false)).toBe(false);
  });
  it("other keys never close a menu", () => {
    expect(closesOpenMenu("ArrowRight", "aa", true)).toBe(false);
    expect(closesOpenMenu("Enter", "toc", true)).toBe(false);
  });
});

// K9 (Renato 11-14, 1a): Klasike, Literata and Atkinson in the Aa menu,
// remembered with the other reader settings on this device.
describe("BookReader fonts (K9)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stored = (value: unknown) =>
    vi.stubGlobal("window", { localStorage: { getItem: () => (value === undefined ? null : JSON.stringify(value)) } });

  it("remembers a picked font", () => {
    stored({ theme: "sepia", step: 3, font: "atkinson" });
    expect(readSettings()).toEqual({ theme: "sepia", step: 3, font: "atkinson" });
  });

  it("older saved settings without a font, and unknown fonts, read as Klasike", () => {
    stored({ theme: "dark", step: 1 });
    expect(readSettings().font).toBe("classic");
    stored({ theme: "dark", step: 1, font: "toString" });
    expect(readSettings().font).toBe("classic");
    stored({ font: "comic" });
    expect(readSettings().font).toBe("classic");
    stored(undefined);
    expect(readSettings()).toEqual({ theme: "light", step: 2, font: "classic" });
  });

  it("the Aa menu has a 'Shkronjat' choice of the three fonts, 48 px tall, each in its own font", () => {
    const src = readFileSync("src/components/book-reader.tsx", "utf8");
    expect(src).toContain('role="radiogroup" aria-label="Shkronjat"');
    expect(src).toMatch(/aria-checked=\{settings\.font === key\}[\s\S]{0,200}className="focus-ring flex h-12 flex-1/);
    expect(src).toContain("fontFamily: READER_FONTS[key].stack");
    expect(src).toContain('style.setProperty("--lb-font", READER_FONTS[settings.font].stack);');
  });
});
