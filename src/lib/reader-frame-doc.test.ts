import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { READER_FRAME_CSP, READER_FRAME_SANDBOX, buildReaderFrameDoc } from "./reader-frame-doc";

// PREVIEW-READER-1: the reader frame's safety settings (capsule "Safety").

describe("reader frame", () => {
  it("is sandboxed without scripts, forms, popups or top navigation", () => {
    expect(READER_FRAME_SANDBOX).toBe("allow-same-origin");
  });

  it("its CSP blocks every load except inline pictures and its own styles", () => {
    expect(READER_FRAME_CSP).toContain("default-src 'none'");
    expect(READER_FRAME_CSP).toContain("img-src data:");
    expect(READER_FRAME_CSP).not.toMatch(/script-src|https?:|'self'|\*/);
  });

  it("puts the CSP first in <head>, before any book content, and adds no script", () => {
    const doc = buildReaderFrameDoc("<p>x</p>");
    expect(doc.indexOf('http-equiv="Content-Security-Policy"')).toBeLessThan(doc.indexOf("<p>x</p>"));
    expect(doc).toMatch(/^<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/);
    expect(doc).not.toMatch(/<script/i);
  });

  it("the reader component uses this sandbox for its frame and never allows scripts", () => {
    const src = readFileSync("src/components/book-reader.tsx", "utf8");
    expect(src).toContain("sandbox={READER_FRAME_SANDBOX}");
    expect(src).not.toContain("allow-scripts");
    expect(src).not.toContain("dangerouslySetInnerHTML");
    expect(readFileSync("src/components/book-sample-reader.tsx", "utf8")).not.toContain("dangerouslySetInnerHTML");
  });
});
