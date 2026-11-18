import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "fs";
import { LibrumLogo } from "./librum-logo";

// LOGO (Renato 11-18, lg1 a): the "librum." wordmark in the header and
// footer, and the "li" icon for the browser tab and home screen.
const read = (f: string) => readFileSync(f, "utf8");

function pngSize(f: string) {
  const b = readFileSync(f);
  expect(b.subarray(1, 4).toString("latin1")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("LibrumLogo", () => {
  it("is one image named Librum for screen readers", () => {
    const html = renderToStaticMarkup(createElement(LibrumLogo, { className: "h-6" }));
    expect(html).toMatch(/^<svg [^>]*role="img"/);
    expect(html).toContain('aria-label="Librum"');
    expect(html).toContain('class="h-6"');
  });

  it("draws the letters in the text colour and the leaning i and full stop in brass", () => {
    const html = renderToStaticMarkup(createElement(LibrumLogo));
    expect(html.match(/fill="currentColor"/g)).toHaveLength(1);
    expect(html.match(/class="fill-accent"/g)).toHaveLength(2);
    expect(html).toContain('transform="rotate(-12');
  });
});

describe("the logo on every page", () => {
  it("the header links home with the logo, not the old serif text", () => {
    const header = read("src/components/site-header.tsx");
    expect(header).toMatch(/<Link\s+href="\/"[^>]*>\s*<LibrumLogo className="block h-6 w-auto" \/>\s*<\/Link>/);
    expect(header).not.toContain("font-serif text-[1.75rem]");
    // lg2 a: 24px logo + 2 x 9px padding = the old 42px tap height.
    expect(header).toContain('className="focus-ring -my-[9px] block rounded-sm py-[9px] text-primary-foreground"');
  });

  it("the footer shows the same logo", () => {
    const footer = read("src/components/site-footer.tsx");
    expect(footer).toContain('<LibrumLogo className="mt-2 mb-3 block h-[1.375rem] w-auto" />');
    expect(footer).not.toContain('<span className="font-serif text-[1.625rem]">Librum</span>');
  });
});

describe("browser tab and home-screen icons", () => {
  it("keeps every icon at its declared size", () => {
    expect(pngSize("public/icons/icon-192.png")).toEqual([192, 192]);
    expect(pngSize("public/icons/icon-512.png")).toEqual([512, 512]);
    expect(pngSize("public/icons/icon-maskable-512.png")).toEqual([512, 512]);
    expect(pngSize("public/icons/apple-touch-icon.png")).toEqual([180, 180]);
  });

  it("the browser-tab icon has 16, 32 and 48 px versions", () => {
    const ico = readFileSync("src/app/favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1); // icon
    const n = ico.readUInt16LE(4);
    const sizes = Array.from({ length: n }, (_, i) => ico[6 + i * 16] || 256).sort((a, b) => a - b);
    expect(sizes).toEqual([16, 32, 48]);
  });
});
