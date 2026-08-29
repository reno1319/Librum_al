import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  getAdminMobileNavAriaLabel,
  shouldCloseAdminMobileNavOnPathnameChange,
  isAdminMobileNavCloseKey,
} from "./admin-mobile-nav";

// MOBILE ADMIN SHELL CORRECTION: two layers of proof, matching this
// codebase's own established split for interactive Client Components
// with no DOM harness available (vitest.config.mts runs `environment:
// "node"`, no jsdom/RTL -- see src/app/error.test.ts's own comment on
// why).
//
//   1. Pure decision logic (which aria-label a given `open` state
//      implies, whether a pathname change should close the drawer,
//      whether a keypress should close it) is now extracted into plain,
//      hook-free functions -- these are called directly below, so this
//      IS real behavioral proof, not a source-text guess.
//
//   2. Everything else (the icon ternary, the {open && (...)} conditional
//      mount, the drawer's own positioning classes, aria-expanded/
//      aria-controls wiring, that the drawer content reuses NavLinks
//      instead of a duplicated <Link> map) cannot be extracted into pure
//      functions without changing what the component actually renders,
//      and cannot be exercised via useState/render here (calling
//      AdminMobileNav() directly, outside a real React render, would
//      violate the Rules of Hooks and throw). These are asserted as
//      source-level regression guards instead, same technique as
//      src/app/error.test.ts -- this proves the JSX still has the
//      expected SHAPE, not that it paints correctly on screen (that is
//      what the live 390px/1440px verification in this pass's own
//      report covers, or reports as a limitation where unavailable).
describe("AdminMobileNav: pure open/closed decision logic", () => {
  describe("getAdminMobileNavAriaLabel", () => {
    it("closed: 'Open administration navigation'", () => {
      expect(getAdminMobileNavAriaLabel(false)).toBe("Open administration navigation");
    });

    it("open: 'Close administration navigation'", () => {
      expect(getAdminMobileNavAriaLabel(true)).toBe("Close administration navigation");
    });
  });

  describe("shouldCloseAdminMobileNavOnPathnameChange", () => {
    it("true when the pathname actually changed -- a nav item was tapped and navigation happened", () => {
      expect(shouldCloseAdminMobileNavOnPathnameChange("/admin/staff", "/admin")).toBe(true);
    });

    it("false when the pathname is unchanged -- no spurious close on every render", () => {
      expect(shouldCloseAdminMobileNavOnPathnameChange("/admin", "/admin")).toBe(false);
    });
  });

  describe("isAdminMobileNavCloseKey", () => {
    it("true for Escape", () => {
      expect(isAdminMobileNavCloseKey("Escape")).toBe(true);
    });

    it("false for any other key", () => {
      expect(isAdminMobileNavCloseKey("Enter")).toBe(false);
      expect(isAdminMobileNavCloseKey("Tab")).toBe(false);
      expect(isAdminMobileNavCloseKey("a")).toBe(false);
    });
  });
});

describe("AdminMobileNav: source-level regression guards", () => {
  const source = readFileSync(path.join(__dirname, "admin-mobile-nav.tsx"), "utf8");

  it("initial state is CLOSED", () => {
    expect(source).toMatch(/const \[open, setOpen\] = useState\(false\)/);
  });

  it("closed state renders the menu trigger (hamburger), not the close icon", () => {
    expect(source).toMatch(/\{open \? <IconClose[^]*?: <IconMenu/);
  });

  it("the drawer/menu content is only mounted while open -- not merely visually hidden", () => {
    expect(source).toMatch(/\{open && \(/);
  });

  it("wires aria-expanded and aria-controls to the actual open state and panel id", () => {
    expect(source).toMatch(/aria-expanded=\{open\}/);
    expect(source).toMatch(/aria-controls=\{panelId\}/);
    expect(source).toMatch(/id=\{panelId\}/);
  });

  it("the trigger toggles open/closed with a single control (tapping X closes it)", () => {
    expect(source).toMatch(/onClick=\{\(\)\s*=>\s*setOpen\(\(v\)\s*=>\s*!v\)\}/);
  });

  it("nav entries render through the shared NavLinks component, not a duplicated Link map", () => {
    expect(source).toMatch(/<NavLinks items=\{items\}/);
    expect(source).not.toMatch(/items\.map\(\(item\)/);
  });

  it("Escape-to-close is wired to isAdminMobileNavCloseKey, not a duplicated inline check", () => {
    expect(source).toMatch(/if \(isAdminMobileNavCloseKey\(e\.key\)\) setOpen\(false\)/);
  });

  it("close-on-navigate is wired to shouldCloseAdminMobileNavOnPathnameChange, not a duplicated inline check", () => {
    expect(source).toMatch(
      /if \(shouldCloseAdminMobileNavOnPathnameChange\(pathname, lastPathname\)\)/,
    );
  });

  it("the aria-label is wired to getAdminMobileNavAriaLabel, not a duplicated inline ternary", () => {
    expect(source).toMatch(/aria-label=\{getAdminMobileNavAriaLabel\(open\)\}/);
  });
});
