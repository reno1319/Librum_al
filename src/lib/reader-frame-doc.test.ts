import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { READER_FONT_FACES, READER_FONTS, READER_FRAME_SANDBOX, buildReaderFrameDoc, readerFrameCsp } from "./reader-frame-doc";

// PREVIEW-READER-1: the reader frame's safety settings (capsule "Safety").

describe("reader frame", () => {
  it("is sandboxed without scripts, forms, popups or top navigation", () => {
    expect(READER_FRAME_SANDBOX).toBe("allow-same-origin");
  });

  it("its CSP blocks every load except inline pictures and its own styles", () => {
    const csp = readerFrameCsp("https://librum.al");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("img-src data:");
    // K9 r2: the one outside source is fonts from this site's /fonts/ path.
    expect(csp).toMatch(/; font-src https:\/\/librum\.al\/fonts\/$/);
    expect(csp.replace("font-src https://librum.al/fonts/", "")).not.toMatch(/script-src|https?:|'self'|\*/);
  });

  it("K9 r2: fonts stay blocked without a plain http(s) origin", () => {
    for (const bad of [undefined, null, "", "null", "javascript:alert(1)", "https://librum.al/x", "https://librum.al; script-src *", "https://a b"]) {
      expect(readerFrameCsp(bad)).toMatch(/; font-src 'none'$/);
    }
    expect(readerFrameCsp("http://127.0.0.1:3101")).toMatch(/; font-src http:\/\/127\.0\.0\.1:3101\/fonts\/$/);
    expect(buildReaderFrameDoc("<p>x</p>", "https://librum.al")).toContain('content="' + readerFrameCsp("https://librum.al") + '"');
  });

  it("K9: the only URLs in the frame document are Librum's five reader fonts, all in public/", () => {
    const urls = [...buildReaderFrameDoc("<p>x</p>").matchAll(/url\(([^)]*)\)/g)].map((m) => m[1]);
    expect(urls).toEqual([
      '"/fonts/literata.woff2"',
      '"/fonts/literata-italic.woff2"',
      '"/fonts/atkinson.woff2"',
      '"/fonts/atkinson-bold.woff2"',
      '"/fonts/atkinson-italic.woff2"',
    ]);
    for (const url of urls) expect(existsSync(`public${url.slice(1, -1)}`)).toBe(true);
    expect(READER_FONT_FACES).not.toMatch(/https?:/);
  });

  it("K9: three fonts, Klasike first and the frame's default", () => {
    expect(Object.keys(READER_FONTS)).toEqual(["classic", "literata", "atkinson"]);
    expect(Object.values(READER_FONTS).map((f) => f.label)).toEqual(["Klasike", "Literata", "Atkinson"]);
    expect(buildReaderFrameDoc("")).toContain(`font-family: var(--lb-font, ${READER_FONTS.classic.stack});`);
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

// K9 r2 (audit B1): OFL §2 needs the licence with every copy of the fonts.
describe("reader font licences", () => {
  it.each([
    ["Literata", "licenses/fonts/Literata-OFL.txt", "Copyright 2017 The Literata Project Authors"],
    ["Atkinson Hyperlegible", "licenses/fonts/AtkinsonHyperlegible-OFL.txt", "Copyright 2020 Braille Institute of America"],
  ])("%s ships with its OFL text", (_name, file, copyright) => {
    const text = readFileSync(file, "utf8");
    expect(text).toContain(copyright);
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });
});
