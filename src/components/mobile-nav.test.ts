import { describe, expect, it, vi } from "vitest";
import { attachOutsideTap, type OutsideTapDocument } from "./mobile-nav";

// PHONE PASS (D5): the site ☰ menu closes on a tap outside it. Called
// with fake root/document objects (vitest runs in `node` with no DOM,
// same split as dismissable-details.test.ts). The real behaviour in a
// browser is checked by hand at 390px.

type Listener = (event: Event) => void;

function setup() {
  const button = { tag: "button" };
  const panelLink = { tag: "a" };
  const outside = { tag: "main" };
  const root = { contains: vi.fn((node: unknown) => node === button || node === panelLink) };
  const listeners = new Map<string, Listener>();
  const doc = {
    addEventListener: vi.fn((type: string, fn: Listener) => listeners.set(type, fn)),
    removeEventListener: vi.fn((type: string, fn: Listener) => {
      if (listeners.get(type) === fn) listeners.delete(type);
    }),
  };
  const close = vi.fn();
  const cleanup = attachOutsideTap(root, doc as unknown as OutsideTapDocument, close);
  const fire = (target: unknown) => listeners.get("pointerdown")?.({ target } as unknown as Event);
  return { button, panelLink, outside, listeners, close, cleanup, fire };
}

describe("attachOutsideTap (site ☰ menu)", () => {
  it("listens for pointerdown on the document only", () => {
    const { listeners } = setup();
    expect([...listeners.keys()]).toEqual(["pointerdown"]);
  });

  it("a pointerdown outside closes the menu", () => {
    const { outside, close, fire } = setup();
    fire(outside);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a pointerdown on the ☰ button or a link in the panel does not", () => {
    const { button, panelLink, close, fire } = setup();
    fire(button);
    fire(panelLink);
    expect(close).not.toHaveBeenCalled();
  });

  it("a pointerdown with no target counts as outside", () => {
    const { close, fire } = setup();
    fire(null);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("cleanup removes the listener", () => {
    const { listeners, cleanup } = setup();
    cleanup();
    expect(listeners.size).toBe(0);
  });
});

// PHONE PASS r2 (audit N2): every ☰ panel link and button is a 44px tap
// target (measured in a browser at 390px; this guards the class).
describe("MobileNav panel tap targets", () => {
  it("the shared link/button class sets min-h-11 and no fixed py-1", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./mobile-nav.tsx", import.meta.url)), "utf8");
    const linkClass = source.match(/const linkClassName =\s*"([^"]+)"/)?.[1] ?? "";
    expect(linkClass.split(/\s+/)).toContain("min-h-11");
    expect(linkClass.split(/\s+/)).not.toContain("py-1");
  });
});
