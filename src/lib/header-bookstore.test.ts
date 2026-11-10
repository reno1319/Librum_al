import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { FREE_BOOKS_HREF, SITE_SEARCH_FORM_ID, headerGenreHref, usesShopHeader } from "./header-bookstore";
import { HeaderSearchForm, HeaderShopLinksView } from "@/components/header-bookstore-controls";
import { GENRES } from "./genres";

// P2 (design B, Renato option a): the header's search box and the cream
// row's Libraria links (P2b: only on Libraria and the book pages).
describe("header links", () => {
  it("a genre opens that genre alone; Libra falas is the free filter", () => {
    expect(headerGenreHref("Horror")).toBe("/librari?genre=Horror");
    expect(headerGenreHref("Drama & teatër")).toBe("/librari?genre=Drama+%26+teat%C3%ABr");
    expect(FREE_BOOKS_HREF).toBe("/librari?maxPrice=0");
  });
});

describe("header markup", () => {
  it("the search form is a plain GET to /librari with a labelled field", () => {
    const html = renderToStaticMarkup(createElement(HeaderSearchForm));
    const form = html.slice(0, html.indexOf(">"));
    for (const attr of [`id="${SITE_SEARCH_FORM_ID}"`, 'action="/librari"', 'method="get"', 'role="search"']) {
      expect(form).toContain(attr);
    }
    expect(html).toContain('<label for="site-search-q" class="sr-only">Kërkoni libra ose autorë</label>');
    const field = html.slice(html.indexOf("<input"), html.indexOf(">", html.indexOf("<input")));
    for (const attr of ['id="site-search-q"', 'type="search"', 'name="q"']) expect(field).toContain(attr);
    expect(html).toContain(">Kërkoni</button>");
  });

  it("the shop links: Libraria, all 18 genres behind one button, Libra falas", () => {
    const html = renderToStaticMarkup(createElement(HeaderShopLinksView, { pathname: "/blog" }));
    expect(html).toMatch(/<a [^>]*href="\/librari"[^>]*>Libraria<\/a>/);
    // Audit B1: on phones the list spans the header, inset 16px, never wider.
    expect(html).toMatch(/<nav aria-label="Zhanret" class="absolute inset-x-4 [^"]*sm:inset-x-auto sm:left-0 sm:w-\[26rem\]"/);
    expect(html).toMatch(/<details class="group sm:relative"/);
    expect(html).toMatch(/<summary[^>]*>Zhanret<svg/);
    expect(html).toContain('<nav aria-label="Zhanret"');
    for (const g of GENRES) expect(html).toContain(`href="${headerGenreHref(g).replace(/&/g, "&amp;")}"`);
    expect(html.match(/<li>/g)).toHaveLength(GENRES.length + 1);
    expect(html).toMatch(/<li><a [^>]*href="\/librari"[^>]*>Të gjitha zhanret<\/a><\/li>/);
    expect(html).toMatch(/href="\/librari\?maxPrice=0"[^>]*>Libra falas</);
    expect(html).not.toContain("aria-current");
  });

  it("marks Libraria as the current page only on Libraria", () => {
    expect(renderToStaticMarkup(createElement(HeaderShopLinksView, { pathname: "/librari" }))).toMatch(
      /<a aria-current="page"[^>]*href="\/librari"[^>]*>Libraria</,
    );
    expect(renderToStaticMarkup(createElement(HeaderShopLinksView, { pathname: "/libra/x" }))).not.toContain(
      "aria-current",
    );
  });

  // The address's query is read only through a page's own searchParams
  // (src/lib/page-messages.sources.test.ts); the header never reads it.
  it("the header controls never read the address's query", () => {
    const source = readFileSync(new URL("../components/header-bookstore-controls.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/useSearchParams|searchParams/);
  });

  // P2b (Renato 11-10 option a): the new header only on Libraria and the
  // book pages; the homepage and every other page keep the old header.
  it("uses the new header only on Libraria and book pages", () => {
    expect(usesShopHeader("/librari")).toBe(true);
    expect(usesShopHeader("/libra/abc-123")).toBe(true);
    const others = [
      "/", "/si-funksionon", "/rreth-nesh", "/fitimet", "/blog", "/blog/x", "/account",
      "/dashboard", "/login", "/library", "/libra", "/libra/", "/libra/x/report",
      "/librari/x", "/librarix", "", null, undefined,
    ];
    for (const p of others) expect(usesShopHeader(p)).toBe(false);
  });

  it("the header switch reads only the pathname", () => {
    const source = readFileSync(new URL("../components/site-header-scope.tsx", import.meta.url), "utf8");
    expect(source).toContain("usePathname");
    expect(source).not.toMatch(/useSearchParams|searchParams/);
  });
});
