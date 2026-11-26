import { describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CategoryShelfTabs, CategoryShelfTabsView, swapAnnouncement, swapsInPlace, tabHandlers } from "./category-shelf-tabs";

// sl-2 b / sl-4 a: the category buttons swap the row in place.
describe("CategoryShelfTabs", () => {
  const tabs = [
    { label: "Të gjitha kategoritë", href: "/librari", row: createElement("p", null, "ROW-ALL") },
    { label: "Horror", href: "/librari?genre=Horror", row: createElement("p", null, "ROW-HORROR") },
  ];
  const view = (props: Partial<Parameters<typeof CategoryShelfTabsView>[0]> = {}) =>
    createElement(CategoryShelfTabsView, { tabs, selected: 0, enhanced: false, announcement: "", choose: () => {}, ...props });

  it("starts on the first button: plain links (no JavaScript yet), the first marked current, only its row shown", () => {
    const html = renderToStaticMarkup(createElement(CategoryShelfTabs, { tabs, more: createElement("span", null, "MORE") }));
    expect(html).toMatch(/<a href="\/librari" aria-current="true" class="[^"]*bg-primary![^"]*">Të gjitha kategoritë<\/a>/);
    expect(html).toMatch(/<a href="\/librari\?genre=Horror" class="[^"]*">Horror<\/a>/);
    expect(html).not.toContain('role="button"');
    expect(html).not.toContain("aria-live");
    expect(html).toContain("ROW-ALL");
    expect(html).not.toContain("ROW-HORROR");
    // The "Më shumë kategori" box sits after the buttons, in the same row.
    expect(html.indexOf("Horror")).toBeLessThan(html.indexOf("MORE"));
    expect(html.indexOf("MORE")).toBeLessThan(html.indexOf("ROW-ALL"));
  });

  it("A1: with JavaScript, each link is a toggle button (aria-pressed) and a polite hidden line announces the row", () => {
    const html = renderToStaticMarkup(view({ enhanced: true, selected: 1, announcement: swapAnnouncement(tabs[1], 1) }));
    expect(html).toMatch(/<a href="\/librari" role="button" aria-pressed="false" class="[^"]*">Të gjitha kategoritë<\/a>/);
    expect(html).toMatch(/<a href="\/librari\?genre=Horror" role="button" aria-pressed="true" class="[^"]*bg-primary![^"]*">Horror<\/a>/);
    expect(html).not.toContain("aria-current");
    expect(html).toContain('<p class="sr-only" aria-live="polite">Po shfaqen librat e rinj në kategorinë Horror.</p>');
    expect(html).toContain("ROW-HORROR");
    expect(html).not.toContain("ROW-ALL");
    // Same look either way: the same classes on each button.
    const classes = (h: string) => [...h.matchAll(/<a [^>]*class="([^"]*)"/g)].map((m) => m[1]);
    expect(classes(html)).toEqual(classes(renderToStaticMarkup(view({ selected: 1 }))));
    expect(swapAnnouncement(tabs[0], 0)).toBe("Po shfaqen librat e rinj nga të gjitha kategoritë.");
  });

  it("the row restarts from its first book on a swap: its wrapper is keyed by the category", () => {
    const keyOfRow = (selected: number) => {
      const fragment = CategoryShelfTabsView({ tabs, selected, enhanced: true, announcement: "", choose: () => {} });
      const kids = (fragment as ReactElement<{ children: unknown[] }>).props.children.filter(isValidElement);
      return kids[kids.length - 1].key;
    };
    expect(keyOfRow(0)).toBe("/librari");
    expect(keyOfRow(1)).toBe("/librari?genre=Horror");
  });

  it("only a plain left click swaps; a modified, middle or handled click opens the link", () => {
    const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    expect(swapsInPlace(plain)).toBe(true);
    for (const change of [{ button: 1 }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { defaultPrevented: true }]) {
      expect(swapsInPlace({ ...plain, ...change }), JSON.stringify(change)).toBe(false);
    }
  });

  it("a plain click stops the page from opening and swaps; a ctrl-click does neither", () => {
    const choose = vi.fn();
    const preventDefault = vi.fn();
    const { onClick } = tabHandlers(1, choose);
    const plain = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false };
    onClick({ ...plain, ctrlKey: true, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    onClick({ ...plain, preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledWith(1);
  });

  it("Space swaps like Enter (and does not scroll the page); other keys are left alone", () => {
    const choose = vi.fn();
    const preventDefault = vi.fn();
    const { onKeyDown } = tabHandlers(2, choose);
    onKeyDown({ key: "a", preventDefault });
    onKeyDown({ key: "Tab", preventDefault });
    expect(choose).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    onKeyDown({ key: " ", preventDefault });
    expect(choose).toHaveBeenCalledWith(2);
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
