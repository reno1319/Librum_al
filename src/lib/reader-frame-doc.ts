// PREVIEW-READER-1: the document the page-turning reader puts in its
// frame. The frame is sandboxed WITHOUT allow-scripts (only
// allow-same-origin, so the reader page can measure and turn pages), and
// this document carries its own Content Security Policy that blocks every
// load except inline pictures (data:) and this stylesheet. No fonts,
// styles, pictures or frames from anywhere else -- the book's own
// HTML has already been through the server cleaner (reader-content.ts).

export const READER_FRAME_SANDBOX = "allow-same-origin";
export const READER_FRAME_CSP =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'";

export type ReaderTheme = "light" | "sepia" | "dark";
export const READER_THEMES: Record<ReaderTheme, { page: string; text: string; muted: string; rule: string }> = {
  light: { page: "#fffdf9", text: "#1f1d1a", muted: "#6f6a62", rule: "#d9d3c7" },
  sepia: { page: "#f4ecd8", text: "#4a3b2a", muted: "#7c6a55", rule: "#d8c9a8" },
  dark: { page: "#1b1b1d", text: "#d8d4cc", muted: "#9a958c", rule: "#3a3a3e" },
};
// Font size steps (multiples of the base size).
export const READER_FONT_STEPS = [0.85, 0.95, 1.05, 1.2, 1.35, 1.5] as const;

const CSS = `
html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; }
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
body {
  background: var(--lb-page); color: var(--lb-text);
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif;
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
.lb-epi { text-indent: 0; margin: 0 1.5em 0 3em; font-style: italic; }
.lb-episrc { text-indent: 0; text-align: right; margin: 0.4em 1.5em 1.8em 3em; color: var(--lb-muted); }
.lb-sample-end { margin: 1.6em 0; border-top: 2px dashed #c0841a; text-align: center; break-inside: avoid; }
.lb-sample-end::after { content: "Këtu mbaron pjesa që shohin lexuesit"; display: inline-block; font: 600 0.7em/1 system-ui, sans-serif; letter-spacing: 0.04em; text-transform: uppercase; color: #c0841a; background: var(--lb-page); padding: 0 0.6em; position: relative; top: -0.55em; }
`;

export function buildReaderFrameDoc(bodyHtml: string): string {
  return `<!doctype html><html lang="sq"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${READER_FRAME_CSP}"><style>${CSS}</style></head><body><div id="lb-root">${bodyHtml}</div></body></html>`;
}
