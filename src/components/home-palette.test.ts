import { describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// HOMEPAGE-2 (Renato 2026-11-19, "Homepage only"): the dark blue look is
// for "/" only; every other page gets the green one.
let pathname = "/";
vi.mock("next/navigation", () => ({ usePathname: () => pathname }));
const { ByPage, PageClass } = await import("./home-palette");

const html = () =>
  renderToStaticMarkup(
    h(PageClass, {
      as: "header",
      home: "navy",
      other: "green",
      children: h(ByPage, { home: h("b", null, "home"), other: h("i", null, "other") }),
    }),
  );

describe("home palette", () => {
  it("the homepage gets the home classes and content", () => {
    pathname = "/";
    expect(html()).toBe('<header class="navy"><b>home</b></header>');
  });

  it.each(["/fitimet", "/rreth-nesh", "/librari", "/libra/abc", "/dashboard"])("%s keeps the usual look", (p) => {
    pathname = p;
    expect(html()).toBe('<header class="green"><i>other</i></header>');
  });

  it.each(["/", "/fitimet"])("%s: a nav keeps its aria-label (Llogaria)", (p) => {
    pathname = p;
    const out = renderToStaticMarkup(
      h(PageClass, { as: "nav", "aria-label": "Llogaria", home: "a", other: "b", children: "x" }),
    );
    expect(out).toBe(`<nav class="${p === "/" ? "a" : "b"}" aria-label="Llogaria">x</nav>`);
  });
});
