import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OrnateShelf, ORNATE_BINDINGS, type OrnateShelfBook } from "./ornate-shelf";

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

  it("writes the title and author on every spine, sideways on the two thin ones", () => {
    const html = render(books(5));
    const spines = html.split(/<li /).slice(1);
    expect(spines).toHaveLength(5);
    spines.forEach((spine, i) => {
      expect(spine).toContain(`>Libri ${i + 1}</span>`);
      expect(spine).toContain(`>Autor ${i + 1}</span>`);
      const sideways = spine.includes("writing-mode:vertical-rl");
      expect(sideways).toBe(ORNATE_BINDINGS[i].width < 65);
      if (sideways) expect(spine).toContain("transform:rotate(180deg)");
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

  it("a long word on a wide spine shrinks instead of overflowing", () => {
    const list = books(5);
    list[0] = { id: "w", title: "Mirëmëngjesi", author: null };
    const spine = render(list).split(/<li /)[1];
    expect(Number(/font-size:([\d.]+)px[^>]*>Mirëmëngjesi/.exec(spine)?.[1])).toBeLessThan(9.5);
  });

  it("a book with no byline draws no author line", () => {
    const html = render([{ id: "x", title: "Pa autor", author: null }]);
    expect(html).toContain(">Pa autor</span>");
    expect(html).not.toContain("Autor");
    expect(html.match(/<span/g)).toHaveLength(1);
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
});
