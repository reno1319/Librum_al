import { describe, expect, it } from "vitest";
import { clickLeavesPage } from "./unsaved-changes-guard";

// Upload notes 1 (Enkelejd 11-06): which link clicks would drop the
// editor's unsaved typing, so the guard asks first.
const HERE = { href: "https://librum.al/dashboard/books/b1/editor?tab=details" };
const click = (o: Partial<Parameters<typeof clickLeavesPage>[0]> = {}) => ({
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
  ...o,
});
const link = (href: string, o: { target?: string; download?: boolean } = {}) => ({
  href,
  target: o.target ?? "",
  hasAttribute: (name: string) => name === "download" && o.download === true,
});

describe("clickLeavesPage", () => {
  it("another tab of the editor, the shelf and another site leave the page", () => {
    expect(clickLeavesPage(click(), link("https://librum.al/dashboard/books/b1/editor?tab=content"), HERE)).toBe(true);
    expect(clickLeavesPage(click(), link("https://librum.al/dashboard/books"), HERE)).toBe(true);
    expect(clickLeavesPage(click(), link("https://example.org/"), HERE)).toBe(true);
    expect(clickLeavesPage(click(), link("https://librum.al/x", { target: "_self" }), HERE)).toBe(true);
  });

  it("a new tab, a download, an in-page # link or a modified click stay", () => {
    expect(clickLeavesPage(click(), link("https://librum.al/dashboard/pen-names", { target: "_blank" }), HERE)).toBe(false);
    expect(clickLeavesPage(click(), link("https://librum.al/api/books/b1/download", { download: true }), HERE)).toBe(false);
    expect(clickLeavesPage(click(), link(`${HERE.href}#pricing-todo`), HERE)).toBe(false);
    for (const mod of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(clickLeavesPage(click(mod), link("https://librum.al/dashboard/books"), HERE)).toBe(false);
    }
    expect(clickLeavesPage(click({ defaultPrevented: true }), link("https://librum.al/dashboard/books"), HERE)).toBe(false);
    expect(clickLeavesPage(click(), link(""), HERE)).toBe(false);
  });
});
