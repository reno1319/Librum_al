import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CREAM_TITLE,
  GREEN_ALONG,
  NAVY_TITLE,
  ORNATE_BINDINGS,
  OXBLOOD_TITLE,
  OrnateShelf,
  SKY_ALONG,
  type OrnateShelfBook,
} from "./ornate-shelf";
import { fitVertical } from "@/lib/ornate-shelf-fit";

function books(n: number): OrnateShelfBook[] {
  return Array.from({ length: n }, (_, i) => ({ id: `b${i + 1}`, title: `Libri ${i + 1}`, author: `Autor ${i + 1}` }));
}

function render(list: OrnateShelfBook[]) {
  return renderToStaticMarkup(createElement(OrnateShelf, { books: list, label: "Newest books" }));
}

// The opening tag of each spine link, in order.
function spineTags(html: string): string[] {
  return [...html.matchAll(/<a [^>]*href="\/books\/[^"]+"[^>]*>/g)].map((m) => m[0]);
}

describe("OrnateShelf", () => {
  it("renders nothing without books", () => {
    expect(render([])).toBe("");
  });

  it("draws at most five spines, one link each, in the board's slot widths", () => {
    const tags = spineTags(render(books(7)));
    expect(tags).toHaveLength(5);
    expect(tags.map((t) => Number(/width:(\d+)px/.exec(t)?.[1]))).toEqual([74, 108, 58, 92, 62]);
    expect(ORNATE_BINDINGS.map((b) => b.width)).toEqual([74, 108, 58, 92, 62]);
  });

  it("gives every spine its book link and the home shelf's accessible name", () => {
    const html = render(books(5));
    for (let i = 1; i <= 5; i++) {
      expect(html).toContain(`href="/books/b${i}"`);
      expect(html).toContain(`aria-label="View Libri ${i} on Librum"`);
    }
    expect(html).toMatch(/^<div[^>]*>.*<ul aria-label="Newest books"/);
  });

  // SHELF-2 (Renato 10-25): every title runs along its spine; the
  // author follows it on the thin spines and stays across on the wide.
  it("writes every title along its spine, bottom to top, and every author", () => {
    const html = render(books(5));
    const spines = html.split(/<li /).slice(1);
    expect(spines).toHaveLength(5);
    spines.forEach((spine, i) => {
      const along = spine.slice(spine.indexOf("writing-mode:vertical-rl;transform:rotate(180deg)"));
      expect(along).toContain(`>Libri ${i + 1}</span>`);
      expect(spine).toContain(`>Autor ${i + 1}</span>`);
      const authorAlong = along.split("</div>")[0].includes(`>Autor ${i + 1}</span>`);
      expect(authorAlong).toBe(ORNATE_BINDINGS[i].width < 65);
    });
  });

  it("a long title on a thin spine is set on two lines side by side, split between words", () => {
    const list = books(5);
    list[2] = { id: "long", title: "Kujtimet e një vere të gjatë në bregdet", author: "Elira Dushku" };
    const spine = render(list).split(/<li /)[3];
    const size = Number(/font-size:([\d.]+)px[^>]*><span[^>]*>Kujtimet/.exec(spine)?.[1]);
    expect(size).toBeGreaterThanOrEqual(10);
    expect(size).toBeLessThan(16);
    expect(spine).toMatch(/<span class="block overflow-hidden text-ellipsis">Kujtimet e një vere<\/span><span class="block overflow-hidden text-ellipsis">të gjatë në bregdet<\/span>/);
    expect(spine).toMatch(/class="[^"]*whitespace-nowrap/);
  });

  it("a short title on a thin spine stays on one line", () => {
    const spine = render(books(5)).split(/<li /)[3];
    expect(spine.match(/class="block overflow-hidden text-ellipsis"/g)).toHaveLength(1);
  });

  it("a title is never broken inside a word: each line is whole words, cut only by an ellipsis", () => {
    const list = books(5);
    list[0] = { id: "w", title: "Frankenstein", author: null };
    list[1] = { id: "x", title: "Crime and Punishment", author: "Fyodor Dostoevsky" };
    list[3] = { id: "y", title: "Kujtimet e një dimri të gjatë në malësi", author: "Besnik Kola" };
    const html = render(list);
    expect(html).not.toMatch(/overflow-wrap:anywhere[^>]*>(Frankenstein|Crime and Punishment|Kujtimet)/);
    expect(html).toContain('<span class="block overflow-hidden text-ellipsis">Frankenstein</span>');
    expect(html).toMatch(/text-ellipsis">Crime and Punishment<\/span>|text-ellipsis">Crime and<\/span><span class="block overflow-hidden text-ellipsis">Punishment<\/span>/);
    const lines = [...html.split(/<li /)[4].matchAll(/text-ellipsis">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(lines.join(" ")).toBe("Kujtimet e një dimri të gjatë në malësi");
    expect(lines.length).toBeGreaterThan(1);
  });

  it("a book with no byline draws no author line", () => {
    const html = render([{ id: "x", title: "Pa autor", author: null }]);
    expect(html).toContain(">Pa autor</span>");
    expect(html).not.toContain("Autor");
    // the title wrapper and its one line, nothing else
    expect(html.match(/<span/g)).toHaveLength(2);
  });

  it("hides every ornament from assistive technology", () => {
    const html = render(books(5));
    const svgs = html.match(/<svg[^>]*>/g) ?? [];
    expect(svgs.length).toBeGreaterThan(20);
    for (const svg of svgs) expect(svg).toContain('aria-hidden="true"');
  });

  // SHELF-1 audit N1: a gradient in objectBoundingBox units paints
  // nothing on a single straight line (zero-height box), so such a rule
  // must have a solid stroke.
  it("no single straight line is stroked with a gradient", () => {
    const html = render(books(5));
    const paths = [...html.matchAll(/<path [^>]*>/g)].map((m) => m[0]);
    const straight = paths.filter((p) => /d="M[\d.]+ [\d.]+ [HV][\d.]+"/.test(p));
    expect(straight.length).toBeGreaterThanOrEqual(7);
    for (const path of straight) expect(path).not.toContain('stroke="url(');
    const gradientPaths = paths.filter((p) => /(stroke|fill)="url\(/.test(p));
    for (const path of gradientPaths) {
      const d = /d="([^"]+)"/.exec(path)?.[1] ?? "";
      expect(d.match(/M/g)?.length ?? 0, d).toSatisfy((moves: number) => moves > 1 || /[CQTLZ]/i.test(d));
    }
  });

  it("escapes titles like any text", () => {
    const html = render([{ id: "x", title: "<b>Hi</b>", author: "A & B" }]);
    expect(html).not.toContain("<b>Hi</b>");
    expect(html).toContain("&lt;b&gt;Hi&lt;/b&gt;");
  });

  it("a long title on the navy spine takes all three lines", () => {
    const list = books(5);
    list[1] = { id: "n", title: "Mirëmëngjesi i qytetit të harruar", author: "Gjergj Kastrioti" };
    const spine = render(list).split(/<li /)[2];
    const lines = [...spine.matchAll(/text-ellipsis">([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(lines).toEqual(["Mirëmëngjesi", "i qytetit", "të harruar"]);
  });

  it("every title band keeps its lines unwrapped (no break inside a line)", () => {
    const spines = render(books(5)).split(/<li /).slice(1);
    for (const spine of spines) {
      expect(spine).toMatch(/class="[^"]*whitespace-nowrap[^"]*"[^>]*writing-mode:vertical-rl/);
    }
  });

  // SHELF-2 audit F1: a title typed in capitals fits every spine. The
  // widths are real Libre Caslon Text measurements at the shelf's own
  // scale (SHELF-2 r2 measure-caps.json): a capital is ~0.70em on the
  // mixed-case spines, and the forced-capitals spines measured 0.71em
  // (oxblood) and 0.78em (navy, bold) per letter; a space ~0.3em.
  it.each([
    ["oxblood", OXBLOOD_TITLE, 0.71, null],
    ["navy", NAVY_TITLE, 0.78, null],
    ["sky", SKY_ALONG, 0.7, "ELIRA DUSHKU"],
    ["cream", CREAM_TITLE, 0.7, null],
    ["green", GREEN_ALONG, 0.7, "MIRA SHALA"],
  ] as const)("a title typed in capitals fits the %s spine without a cut", (_name, options, realEm, author) => {
    for (const title of ["NË KËRKIM TË KOHËS SË HUMBUR NË TIRANË", "DRITA E VERIUT TË LARGËT", "FJALËT E NËNËS SIME", "MËMËDHEU"]) {
      const fit = fitVertical(title, author, options);
      expect(fit.titleFits).toBe(true);
      const authorLength = author ? author.length * options.author!.emPerChar * fit.authorPx + options.gapPx : 0;
      const realLength = (line: string) => [...line].reduce((sum, ch) => sum + (ch === " " ? 0.3 : realEm), 0);
      const longest = Math.max(...fit.titleLines.map(realLength));
      expect(longest * fit.titlePx + authorLength).toBeLessThanOrEqual(options.lengthPx + 0.5);
    }
  });
});

