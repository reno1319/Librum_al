import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-1: this codebase deliberately avoids
// React Testing Library (see src/app/dashboard/books/[id]/edit/
// page.test.ts's own comment) -- vitest.config.mts runs a plain node
// environment with no jsdom, and only ever includes "*.test.ts", not
// ".tsx". A real render-and-click verification of this error boundary
// (does Retry actually invoke reset(), does it render correctly at
// 390/1440px) was instead done live against a temporary throwing route
// and a real dev server -- see this pass's own report. This is the
// practical, narrow alternative already established by this repo: a
// source-level regression guard against reintroducing exactly the
// defects this file was written to fix.
describe("Root error boundary: source-level regression guards", () => {
  const source = readFileSync(path.join(__dirname, "error.tsx"), "utf8");

  it("is a Client Component -- required by Next.js for error.tsx", () => {
    expect(source).toMatch(/^"use client";/);
  });

  it("wires the Retry action to Next's own reset(), not a manual reload", () => {
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

  it("renders exactly one H1", () => {
    const matches = source.match(/<h1[\s>]/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
