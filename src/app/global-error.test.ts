import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-1: same source-scan-guard approach as
// error.test.ts (see that file's own comment for why -- no jsdom/RTL
// in this repo). global-error.tsx has one extra hard requirement from
// Next.js itself: it must supply its own complete <html>/<body> shell,
// since it replaces the ENTIRE root layout, not just the page subtree.
describe("Global error boundary: source-level regression guards", () => {
  const source = readFileSync(path.join(__dirname, "global-error.tsx"), "utf8");

  it("is a Client Component -- required by Next.js for global-error.tsx", () => {
    expect(source).toMatch(/^"use client";/);
  });

  it("supplies its own html/body shell, as Next.js requires here", () => {
    expect(source).toMatch(/<html[\s>]/);
    expect(source).toMatch(/<body[\s>]/);
  });

  it("does not depend on SiteHeader/SiteFooter -- those may be implicated in why the root layout itself failed", () => {
    expect(source).not.toMatch(/import\s*\{[^}]*(SiteHeader|SiteFooter)/);
    expect(source).not.toMatch(/<SiteHeader|<SiteFooter/);
  });

  it("wires the Retry action to Next's own reset()", () => {
    expect(source).toMatch(/onClick=\{\(\)\s*=>\s*reset\(\)\}/);
  });

  it("provides a safe home action", () => {
    expect(source).toMatch(/href="\/"/);
  });

  it("never renders the raw error object -- message, digest, or stack", () => {
    expect(source).not.toMatch(/\{error\.message\}/);
    expect(source).not.toMatch(/\{error\.digest\}/);
    expect(source).not.toMatch(/\{error\.stack\}/);
  });

  it("logs the error server/console-side instead of discarding it silently", () => {
    expect(source).toMatch(/console\.error\(.*error/);
  });
});
