// PREVIEW-READER-1: the document the page-turning reader puts in its
// frame. The frame is sandboxed WITHOUT allow-scripts (only
// allow-same-origin, so the reader page can measure and turn pages), and
// this document carries its own Content Security Policy that blocks every
// load except inline pictures (data:), this stylesheet and (K9, Renato
// 11-14) Librum's own reader fonts from <this site>/fonts/ only (K9 r2:
// path-limited, so even injected CSS could not reach any other page). No
// styles, pictures, frames or outside fonts -- the book's own HTML has
// already been through the server cleaner (reader-content.ts), which
// drops every <style> and style attribute, so only the @font-face rules
// below can ask for a font.

export const READER_FRAME_SANDBOX = "allow-same-origin";
const CSP_BASE =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";
// Only a plain http(s) origin (scheme, host, optional port) is accepted.
const ORIGIN = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/i;

/**
 * The frame's CSP. Fonts load only from `${origin}/fonts/`; with no
 * usable origin (server render, tests) every font stays blocked and the
 * reader falls back to the device's own Klasike stack.
 */
export function readerFrameCsp(origin?: string | null): string {
  const fontSrc = origin && ORIGIN.test(origin) ? `${origin}/fonts/` : "'none'";
  return `${CSP_BASE}; font-src ${fontSrc}`;
}

export type ReaderTheme = "light" | "sepia" | "dark";
export const READER_THEMES: Record<ReaderTheme, { page: string; text: string; muted: string; rule: string }> = {
  light: { page: "#fffdf9", text: "#1f1d1a", muted: "#6f6a62", rule: "#d9d3c7" },
  sepia: { page: "#f4ecd8", text: "#4a3b2a", muted: "#7c6a55", rule: "#d8c9a8" },
  dark: { page: "#1b1b1d", text: "#d8d4cc", muted: "#9a958c", rule: "#3a3a3e" },
};
// K9 (Renato 11-14, 1a): the reader's three typefaces. Classic is the
// device's own book serif (nothing downloaded); Literata (made for
// ebooks) and Atkinson Hyperlegible (for low-vision readers) are
// self-hosted from public/fonts/ (both SIL OFL, licence texts in
// licenses/fonts/; latin subset: full
// ë and ç). A font only downloads once a reader picks it.
export type ReaderFont = "classic" | "literata" | "atkinson";
export const READER_FONTS: Record<ReaderFont, { label: string; stack: string }> = {
  classic: { label: "Klasike", stack: `"Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif` },
  literata: { label: "Literata", stack: `"Lb Literata", Georgia, "Times New Roman", serif` },
  atkinson: { label: "Atkinson", stack: `"Lb Atkinson", system-ui, -apple-system, "Segoe UI", Arial, sans-serif` },
};
/** The @font-face rules for the two downloadable fonts (frame and page). */
export const READER_FONT_FACES = `
@font-face { font-family: "Lb Literata"; src: url("/fonts/literata.woff2") format("woff2"); font-weight: 200 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Lb Literata"; src: url("/fonts/literata-italic.woff2") format("woff2"); font-weight: 400; font-style: italic; font-display: swap; }
@font-face { font-family: "Lb Atkinson"; src: url("/fonts/atkinson.woff2") format("woff2"); font-weight: 400; font-style: normal; font-display: swap; }
@font-face { font-family: "Lb Atkinson"; src: url("/fonts/atkinson-bold.woff2") format("woff2"); font-weight: 700; font-style: normal; font-display: swap; }
@font-face { font-family: "Lb Atkinson"; src: url("/fonts/atkinson-italic.woff2") format("woff2"); font-weight: 400; font-style: italic; font-display: swap; }
`;

// Font size steps (multiples of the base size).
export const READER_FONT_STEPS = [0.85, 0.95, 1.05, 1.2, 1.35, 1.5] as const;

const CSS = `${READER_FONT_FACES}
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  background: var(--lb-page); color: var(--lb-text);
  font-family: var(--lb-font, ${READER_FONTS.classic.stack});
  font-size: calc(18px * var(--lb-scale, 1.05)); line-height: 1.6;
  -webkit-user-select: none; user-select: none;
  font-kerning: normal; font-variant-ligatures: common-ligatures;
  overflow-wrap: break-word; hyphens: manual;
}
#lb-root {
  box-sizing: border-box; height: 100%; width: 100%;
  padding: var(--lb-pad-y, 40px) var(--lb-pad, 32px);
  column-count: var(--lb-cols, 1); column-gap: calc(var(--lb-pad, 32px) * 2); column-fill: auto;
  overflow: hidden;
}
.lb-sec + .lb-sec { break-before: column; -webkit-column-break-before: always; }
.lb-break { break-after: column; -webkit-column-break-after: always; height: 0; margin: 0; overflow: hidden; color: transparent; }
.lb-pb { break-before: column; -webkit-column-break-before: always; }
p { margin: 0; text-indent: 1.3em; text-align: left; orphans: 2; widows: 2; }
h1 + p, h2 + p, h3 + p, h4 + p, hr + p, .lb-scene + p, .lb-epi + p, .lb-episrc + p, blockquote + p, figure + p, p:first-child { text-indent: 0; }
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; text-align: center; break-after: avoid; -webkit-column-break-after: avoid; text-indent: 0; }
h1 { font-size: 1.55em; margin: 2.4em 0 1.4em; font-weight: 500; letter-spacing: 0.01em; }
h2 { font-size: 1.3em; margin: 1.8em 0 1em; font-weight: 500; }
h3 { font-size: 1.1em; margin: 1.4em 0 0.8em; }
h4, h5, h6 { font-size: 1em; margin: 1.2em 0 0.6em; }
.lb-sec > h1:first-child, .lb-sec > h2:first-child { margin-top: 3.2em; }
blockquote { margin: 0.9em 1.4em; }
blockquote p { text-indent: 0; }
ul, ol { margin: 0.6em 0 0.6em 1.4em; padding: 0; }
li { margin: 0.2em 0; }
hr { border: 0; border-top: 1px solid var(--lb-rule); width: 30%; margin: 1.4em auto; }
img { display: block; max-width: 100%; max-height: calc(var(--lb-h, 600px) - 2em); height: auto; margin: 0.8em auto; break-inside: avoid; -webkit-column-break-inside: avoid; }
figure { margin: 1em 0; break-inside: avoid; -webkit-column-break-inside: avoid; }
figcaption { font-size: 0.85em; color: var(--lb-muted); text-align: center; margin-top: 0.4em; }
table { border-collapse: collapse; margin: 1em 0; font-size: 0.9em; max-width: 100%; }
td, th { border: 1px solid var(--lb-rule); padding: 0.3em 0.5em; vertical-align: top; }
sup, sub { font-size: 0.72em; line-height: 0; }
small { font-size: 0.85em; }
aside.lb-note, aside { font-size: 0.85em; color: var(--lb-muted); margin: 1em 0 0; }
.lb-c { text-align: center; text-indent: 0; }
.lb-r { text-align: right; text-indent: 0; }
.lb-l { text-align: left; }
.lb-j { text-align: left; }
.lb-i { font-style: italic; }
.lb-b { font-weight: 700; }
.lb-sc { font-variant: small-caps; letter-spacing: 0.03em; }
.lb-ni { text-indent: 0; }
.lb-in { margin-left: 1.5em; text-indent: 0; }
.lb-scene { text-align: center; text-indent: 0; margin: 1em 0; letter-spacing: 0.3em; }
.lb-verse { text-indent: 0; margin-left: 1em; }
.lb-stanza { margin-top: 1em; }
.lb-verse-in { text-indent: 0; margin-left: 3em; }
.lb-gap { margin: 0; text-indent: 0; min-height: 1em; }
/* lbnp2: Librum's own copyright and last pages (reader-librum-pages.ts), tighter so the copyright page fits one screen, like the download's. Never emitted by the book cleaner. */
.lb-lp { line-height: 1.4; }
.lb-lp > h1:first-child { margin: 1.2em 0 0.5em; }
.lb-lp p { margin: 0.15em 0; text-indent: 0; }
.lb-lp .lb-gap { min-height: 0.6em; }
.lb-epi { text-indent: 0; margin: 0 1.5em 0 3em; font-style: italic; }
.lb-episrc { text-indent: 0; text-align: right; margin: 0.4em 1.5em 1.8em 3em; color: var(--lb-muted); }
mark { background: none; color: inherit; }
mark.lb-hl { color: inherit; border-radius: 2px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.lb-hl-yellow { background: rgba(240, 200, 40, 0.42); }
.lb-hl-green { background: rgba(110, 190, 90, 0.38); }
.lb-hl-blue { background: rgba(90, 150, 230, 0.36); }
.lb-hl-pink { background: rgba(235, 110, 160, 0.36); }
.lb-sample-end { margin: 1.6em 0; border-top: 2px dashed #c0841a; text-align: center; break-inside: avoid; }
.lb-sample-end::after { content: "Këtu mbaron pjesa që shohin lexuesit"; display: inline-block; font: 600 0.7em/1 system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; color: #c0841a; background: var(--lb-page); padding: 0 0.6em; position: relative; top: -0.55em; }
`;

export function buildReaderFrameDoc(bodyHtml: string, origin?: string | null): string {
  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${readerFrameCsp(origin)}"><style>${CSS}</style></head><body><div id="lb-root">${bodyHtml}</div></body></html>`;
}
