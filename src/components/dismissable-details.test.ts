import { describe, expect, it, vi } from "vitest";
import { attachDismiss, type DismissDetails, type DismissDocument } from "./dismissable-details";

// LEFTOVERS (L1): the dismiss logic of the floating <details> menus,
// called directly with fake element/document objects (vitest runs in
// `node` with no DOM; same split as admin-mobile-nav.test.ts). The real
// behaviour in a browser is checked by hand at 390px and 1280px.

type Listener = (event: Event) => void;

function setup(activeElement: "inside" | "body" | "outside" | null = "body") {
  const summary = { focus: vi.fn() };
  const insideNodes = new Set<unknown>();
  const link = { tag: "a" };
  const minPrice = { tag: "input#bookstore-min-price" };
  const maxPrice = { tag: "input#bookstore-max-price" };
  const outside = { tag: "input#header-search" };
  for (const n of [summary, link, minPrice, maxPrice]) insideNodes.add(n);

  const details = {
    open: true,
    contains: vi.fn((node: unknown) => node === details || insideNodes.has(node)),
    querySelector: vi.fn((selector: string) => (selector === "summary" ? summary : null)),
  };
  insideNodes.add(details);

  const listeners = new Map<string, Listener>();
  const body = { tag: "body" };
  const doc = {
    body,
    activeElement:
      activeElement === "inside" ? minPrice : activeElement === "body" ? body : activeElement === "outside" ? outside : null,
    addEventListener: vi.fn((type: string, fn: Listener) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    }),
  };

  const cleanup = attachDismiss(details as unknown as DismissDetails, doc as unknown as DismissDocument);
  const fire = (type: string, event: object) => listeners.get(type)?.(event as Event);
  return { details, summary, link, minPrice, maxPrice, outside, doc, listeners, cleanup, fire };
}

describe("attachDismiss", () => {
  it("listens for pointerdown and keydown on the document", () => {
    const { listeners } = setup();
    expect([...listeners.keys()].sort()).toEqual(["keydown", "pointerdown"]);
  });

  it("a pointerdown outside closes it", () => {
    const { details, outside, fire } = setup();
    fire("pointerdown", { target: outside });
    expect(details.open).toBe(false);
  });

  it("a pointerdown inside (the summary, a link, the price min/max fields) does not close it", () => {
    const { details, summary, link, minPrice, maxPrice, fire } = setup();
    for (const target of [details, summary, link, minPrice, maxPrice]) {
      fire("pointerdown", { target });
      expect(details.open).toBe(true);
    }
  });

  it("other keys do not close it", () => {
    const { details, summary, fire } = setup();
    for (const key of ["Enter", " ", "Tab", "1"]) fire("keydown", { key });
    expect(details.open).toBe(true);
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it.each([
    ["inside the menu", "inside"],
    ["on <body>", "body"],
    ["nowhere (null)", null],
  ] as const)("Escape closes it and focuses the summary when focus was %s", (_label, active) => {
    const { details, summary, fire } = setup(active);
    fire("keydown", { key: "Escape" });
    expect(details.open).toBe(false);
    expect(summary.focus).toHaveBeenCalledTimes(1);
  });

  it("Escape with focus in another field closes it but leaves focus where it is", () => {
    const { details, summary, fire } = setup("outside");
    fire("keydown", { key: "Escape" });
    expect(details.open).toBe(false);
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("Escape when it is already closed does nothing", () => {
    const { details, summary, fire } = setup("inside");
    details.open = false;
    fire("keydown", { key: "Escape" });
    expect(summary.focus).not.toHaveBeenCalled();
  });

  it("cleanup removes both listeners (the same functions it added)", () => {
    const { doc, listeners, cleanup } = setup();
    const added = doc.addEventListener.mock.calls.map(([type, fn]) => [type, fn]);
    cleanup();
    expect(doc.removeEventListener.mock.calls.map(([type, fn]) => [type, fn])).toEqual(added);
    expect(listeners.size).toBe(0);
  });
});
