import JSZip from "jszip";
import type { RightsBasis } from "@/lib/types";
import { resolveTranslatorLine, resolveTranslatorNames, TRANSLATED_BY } from "@/lib/book-byline";

// BD3 + BD4 + BD4b (Renato 1 Nov 2026: 1a 2a 3a 4a 5a, wording "ok"):
// every downloaded book gets one Librum page at the front (the
// copyright page, plus the buyer line) and one at the end ("more by
// this author" and a review link). They are added on the way out, at
// download time, so they always show the current book details; the
// stored file is never changed (W7 2a), and the same step works for a
// Word-made ebook and for an EPUB the author uploaded.
//
// Fail-open, like watermark.ts: a file whose shape this cannot handle
// is served exactly as stored, and the caller logs it. Never logs here.

export type LibrumFrontPage = {
  title: string;
  subtitle: string | null;
  penName: string;
  // BD3 patch 4 (1a, 6a): the "Autori origjinal", or null. When set it
  // is the byline, and "Përktheu:" names the translators (else the pen
  // name) right under it.
  originalAuthor: string | null;
  // 4a: the original publication year when the author gave one,
  // otherwise the year the book first went up on Librum.
  copyrightYear: number;
  // BD3 patch 4 (6a): the original publication year only, null when the
  // author gave no date. The original author's © line omits a missing
  // year; it never falls back to the Librum year (coordinator rule).
  originalYear: number | null;
  // 4a: the translator holds © for the translation (year on Librum).
  translators: string[];
  // BD3 patch 3 (Renato 1 Nov, 1a 2a): the rights basis the author
  // declared last. "public_domain": no © and no "may not copy" line;
  // "public_domain_original": © for the translation only.
  rights: RightsBasis;
  librumYear: number;
  isbn: string | null;
  publisher: string | null;
  edition: string | null;
  // D13 1b: the buyer's own email, the purchase date and code. null for
  // the author's own download.
  buyer: { email: string; date: string; code: string; free: boolean } | null;
};

export type LibrumLastPage = {
  penName: string;
  // 5a: up to 5 other live books under the same pen name, newest first.
  books: Array<{ title: string; url: string }>;
  reviewUrl: string;
};

export type LibrumPagesFailureStage = "unsupported_structure" | "unexpected_exception";

export type LibrumPagesResult =
  | { added: true; bytes: Buffer }
  | { added: false; bytes: Buffer; failureStage: LibrumPagesFailureStage };

export const MAX_MORE_BOOKS = 5;

// The approved wording (thread, 1 Nov 10:13Z).
export const RIGHTS_LINE = "Të gjitha të drejtat e rezervuara.";
export const PERSONAL_USE_LINE =
  "Ky libër elektronik është vetëm për përdorimin tuaj personal. Nuk lejohet kopjimi, shpërndarja ose shitja e tij, plotësisht ose pjesërisht, pa lejen me shkrim të autorit.";
export const MORE_BOOKS_HEADING = "Libra të tjerë nga";
export const REVIEW_LINE = "Ju pëlqeu libri? Lini një vlerësim në Librum.";
// BD3 patch 2 (Renato 1 Nov, a): the last page opens with a thank-you.
export const THANKS_LINE = "Faleminderit që lexuat!";
// BD3 patch 3 (Renato 1 Nov, 1a and 2a).
export const PUBLIC_DOMAIN_LINE = "Vepër në domenin publik.";
export const PUBLIC_DOMAIN_ORIGINAL_LINE = "Vepra origjinale në domenin publik.";
export { TRANSLATED_BY };

const XML_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => XML_ESCAPE[c]);
}

// Control characters other than tab/newline are not allowed in XML.
function clean(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").trim();
}

function line(text: string, cls?: string): string {
  return `<p${cls ? ` class="${cls}"` : ""}>${esc(clean(text))}</p>`;
}

// BD3 patch 2 (Renato's Apple Books test, 1 Nov): readers apply their
// own styles to headings (Apple Books left-aligns h1/h2) and split words
// with English rules ("rez-ervuara"), so every element says centered
// and no word-splitting itself instead of inheriting it from body.
const STYLE = `body{margin:0;padding:0 1em;text-align:center;font-family:serif;line-height:1.5}
body,h1,h2,p,ul,li{text-align:center !important;-webkit-hyphens:none !important;-epub-hyphens:none;-moz-hyphens:none;hyphens:none !important;adobe-hyphenate:none}
h1{font-size:1.6em;margin:2.5em 0 .3em;font-weight:bold}
h1.thanks{font-size:1.4em;margin:2em 0 1.5em}
h2{font-size:1.25em;margin:2em 0 .8em}
p{margin:.35em 0;text-indent:0}
.sub{font-style:italic}
.author{margin:.6em 0 2.5em;font-size:1.15em}
.gap{margin-top:1.8em}
.small{font-size:.85em}
ul{list-style:none;padding:0;margin:0 0 2em}
li{margin:.5em 0}`;

function documentHtml(epub2: boolean, title: string, body: string): string {
  const head = `<head>
<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
<title>${esc(clean(title))}</title>
<style type="text/css">${STYLE}</style>
</head>`;
  if (epub2) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="sq">
${head}
<body>
${body}
</body>
</html>
`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="sq" xml:lang="sq">
${head}
<body>
${body}
</body>
</html>
`;
}

export function frontPageBody(p: LibrumFrontPage): string {
  const out: string[] = [];
  out.push(`<h1>${esc(clean(p.title))}</h1>`);
  if (p.subtitle && clean(p.subtitle)) out.push(line(p.subtitle, "sub"));
  const translators = p.translators.map(clean).filter(Boolean);
  const originalAuthor = p.originalAuthor ? clean(p.originalAuthor) || null : null;
  // 1a (16:05Z): the translators the author typed, else the pen name.
  const translatedBy = resolveTranslatorNames(translators, clean(p.penName));
  if (originalAuthor) {
    // Patch 4 (1a): the original author is the byline; the translator
    // line sits under it, in the same block. A "public_domain" book
    // names only typed translators (audit r1, H1: it can be an
    // untranslated original), so it may have no translator line.
    const translatorLine = resolveTranslatorLine(translators, clean(p.penName), p.rights);
    out.push(
      translatorLine
        ? `<p class="author">${esc(originalAuthor)}<br/>${esc(`${TRANSLATED_BY} ${translatorLine}`)}</p>`
        : line(originalAuthor, "author"),
    );
  } else {
    out.push(line(p.penName, "author"));
  }
  if (p.rights === "public_domain") {
    // 1a: the author declared the whole book, any translation included,
    // public domain: no ©, no "all rights reserved", no copy ban.
    out.push(line(PUBLIC_DOMAIN_LINE));
    // With an original author the byline already says who translated it.
    if (!originalAuthor && translators.length > 0) out.push(line(`${TRANSLATED_BY} ${translators.join(", ")}.`));
  } else if (p.rights === "public_domain_original") {
    // 2a: © for the translation only. With no translator listed, the
    // author declared the translation is theirs: their pen name.
    out.push(line(PUBLIC_DOMAIN_ORIGINAL_LINE));
    out.push(line(`Përkthimi © ${p.librumYear} ${translatedBy}.`));
  } else if (originalAuthor) {
    // Patch 4 (6a): a licensed translation. The original author's ©
    // (year only when given), then the translation's, on the Librum year.
    out.push(line(`© ${p.originalYear !== null ? `${p.originalYear} ` : ""}${originalAuthor}.`));
    out.push(line(`Përkthimi © ${p.librumYear} ${translatedBy}.`));
    out.push(line(RIGHTS_LINE));
  } else {
    out.push(line(`© ${p.copyrightYear} ${clean(p.penName)}. ${RIGHTS_LINE}`));
    if (translators.length > 0) {
      out.push(line(`Përkthimi © ${p.librumYear} ${translators.join(", ")}.`));
    }
  }
  if (p.isbn && clean(p.isbn)) out.push(line(`ISBN ${clean(p.isbn)}`));
  if (p.publisher && clean(p.publisher)) out.push(line(p.publisher));
  if (p.edition && clean(p.edition)) out.push(line(p.edition));
  out.push(line(`Botuar në Librum, ${p.librumYear} · librum.al`, "gap"));
  if (p.rights !== "public_domain") out.push(line(PERSONAL_USE_LINE, "gap small"));
  if (p.buyer) {
    const verb = p.buyer.free ? "Shkarkuar falas nga" : "Blerë nga";
    out.push(line(`${verb} ${p.buyer.email} më ${p.buyer.date} · Kodi i blerjes: ${p.buyer.code}`, "gap small"));
  }
  return out.join("\n");
}

export function lastPageBody(p: LibrumLastPage): string {
  const out: string[] = [`<h1 class="thanks">${esc(THANKS_LINE)}</h1>`];
  const books = p.books.slice(0, MAX_MORE_BOOKS);
  if (books.length > 0) {
    out.push(`<h2>${esc(`${MORE_BOOKS_HEADING} ${clean(p.penName)}`)}</h2>`);
    out.push(
      `<ul>\n${books.map((b) => `<li><a href="${esc(b.url)}">${esc(clean(b.title))}</a></li>`).join("\n")}\n</ul>`,
    );
  }
  out.push(`<p class="gap"><a href="${esc(p.reviewUrl)}"><strong>${esc(REVIEW_LINE)}</strong></a></p>`);
  return out.join("\n");
}

export function frontPageXhtml(p: LibrumFrontPage, epub2 = false): string {
  return documentHtml(epub2, p.title, frontPageBody(p));
}

export function lastPageXhtml(p: LibrumLastPage, epub2 = false): string {
  return documentHtml(epub2, p.penName, lastPageBody(p));
}

// The book purchase code shown to the buyer: the first 8 characters of
// the purchase id, upper case, so staff can find the row by prefix.
export function purchaseCode(purchaseId: string): string {
  return `LB-${purchaseId.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

// Comments and CDATA blanked out with spaces of the same length, so
// every match below sees markup only and its offsets still point into
// the real file (audit r1, MEDIUM: a "</manifest>" inside a comment).
function maskComments(xml: string): string | null {
  const masked = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length));
  // An unclosed comment or CDATA: the file is not what it seems.
  return /<!--|<!\[CDATA\[/.test(masked) ? null : masked;
}

// A whole-word "cover" or "kopertin…" (also "coverpage", "cover-image",
// "cover.xhtml", "coverImage", "bookcover", "frontcover"), never
// "discovery", "recover" or "uncover" (audits r1 and r2).
const COVER_WORD_RE = /(?:^|[^a-z])(?:book|front)?(?:cover(?:page|image|img)?|kopertin[a-z]*)(?:[^a-z]|$)/i;

// EPUB 2's <guide><reference type="cover" href="…"/>: Calibre names its
// cover page "titlepage.xhtml" and marks it only here (audit r2, N2).
function guideCoverHref(maskedOpf: string): string | null {
  for (const ref of maskedOpf.match(/<([a-zA-Z0-9]+:)?reference\b[^>]*>/gi) ?? []) {
    if (!/\btype\s*=\s*["']cover["']/i.test(ref)) continue;
    const href = ref.match(/\bhref\s*=\s*["']([^"'#]*)/i)?.[1];
    if (href) return href;
  }
  return null;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

function uniqueName(zip: JSZip, dir: string, base: string): string {
  let name = `${base}.xhtml`;
  for (let n = 2; zip.file(`${dir}${name}`); n++) name = `${base}-${n}.xhtml`;
  return name;
}

function uniqueId(opf: string, base: string): string {
  let id = base;
  for (let n = 2; new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(opf); n++) id = `${base}-${n}`;
  return id;
}

function injectionLanded(opf: string, ids: string[]): boolean {
  const m = maskComments(opf);
  if (m === null) return false;
  const manifest = m.match(/<([a-zA-Z0-9]+:)?manifest\b[^>]*>([\s\S]*?)<\/([a-zA-Z0-9]+:)?manifest\s*>/i);
  const spine = m.match(/<([a-zA-Z0-9]+:)?spine\b[^>]*>([\s\S]*?)<\/([a-zA-Z0-9]+:)?spine\s*>/i);
  if (!manifest || !spine) return false;
  return ids.every((id) => {
    const inManifest = manifest[2].split(`<${manifest[1] ?? ""}item id="${id}" `).length - 1;
    const inSpine = spine[2].split(`<${manifest[1] ?? ""}itemref idref="${id}"/>`).length - 1;
    const anywhere = m.split(`"${id}"`).length - 1;
    return inManifest === 1 && inSpine === 1 && anywhere === 2;
  });
}

// Adds the two pages to an EPUB. Only touches the package file (two
// manifest items, two spine entries) and adds two new XHTML files; every
// existing file stays byte-for-byte the same.
export async function addLibrumPages(
  bytes: Buffer,
  pages: { front: LibrumFrontPage; last: LibrumLastPage },
): Promise<LibrumPagesResult> {
  const unsupported = (): LibrumPagesResult => ({ added: false, bytes, failureStage: "unsupported_structure" });
  try {
    const zip = await JSZip.loadAsync(bytes);
    const container = zip.file("META-INF/container.xml");
    if (!container) return unsupported();
    const rootfile = (await container.async("string")).match(/full-path\s*=\s*["']([^"']+)["']/i);
    if (!rootfile) return unsupported();
    const opfPath = rootfile[1];
    const opfFile = zip.file(opfPath);
    if (!opfFile) return unsupported();
    const opf = await opfFile.async("string");
    const m = maskComments(opf);
    if (m === null) return unsupported();

    // A fixed-layout book (every page a picture) has no place for a
    // reflowable text page; it is served as stored.
    if (/rendition:layout[^<]*pre-paginated/i.test(m)) return unsupported();

    const pkg = m.match(/<([a-zA-Z0-9]+:)?package\b[^>]*\bversion\s*=\s*["']([0-9.]+)["']/i);
    if (!pkg) return unsupported();
    const epub2 = pkg[2].startsWith("2");

    // Exactly one manifest and one spine, or the file is not handled.
    if ((m.match(/<\/([a-zA-Z0-9]+:)?manifest\s*>/gi) ?? []).length !== 1) return unsupported();
    if ((m.match(/<([a-zA-Z0-9]+:)?spine\b/gi) ?? []).length !== 1) return unsupported();
    const manifestClose = m.match(/<\/([a-zA-Z0-9]+:)?manifest\s*>/i);
    const spineOpen = m.match(/<([a-zA-Z0-9]+:)?spine\b[^>]*?(\/?)>/i);
    const spineClose = m.match(/<\/([a-zA-Z0-9]+:)?spine\s*>/i);
    if (!manifestClose || !spineOpen || spineOpen[2] === "/" || !spineClose) return unsupported();
    if (manifestClose.index! > spineOpen.index! || spineOpen.index! > spineClose.index!) return unsupported();
    const prefix = manifestClose[1] ?? "";

    const dir = dirOf(opfPath);
    const frontName = uniqueName(zip, dir, "librum-faqja-hyrese");
    const lastName = uniqueName(zip, dir, "librum-faqja-fundit");
    const frontId = uniqueId(opf, "librum-front");
    const lastId = uniqueId(opf, "librum-end");
    if (frontId === lastId) return unsupported();

    // The front page goes first, after a cover page when the book opens
    // on one (Word-made books have none; many uploaded EPUBs do).
    const spineStart = spineOpen.index! + spineOpen[0].length;
    const spineInner = m.slice(spineStart, spineClose.index!);
    let frontAt = spineStart;
    const firstRef = spineInner.match(/<([a-zA-Z0-9]+:)?itemref\b[^>]*?\bidref\s*=\s*["']([^"']+)["'][^>]*?\/?>/i);
    if (firstRef) {
      const idref = firstRef[2];
      const item = m.match(new RegExp(`<([a-zA-Z0-9]+:)?item\\b[^>]*\\bid\\s*=\\s*["']${idref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`, "i"));
      const attr = (name: string) => item?.[0].match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
      const guideCover = guideCoverHref(m);
      const looksLikeCover =
        COVER_WORD_RE.test(idref) ||
        COVER_WORD_RE.test(attr("href")) ||
        /(?:^|\s)cover-image(?:\s|$)/i.test(attr("properties")) ||
        (!!guideCover && guideCover === attr("href"));
      if (looksLikeCover) frontAt = spineStart + firstRef.index! + firstRef[0].length;
    }

    const item = (id: string, href: string) =>
      `<${prefix}item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`;
    const ref = (id: string) => `<${prefix}itemref idref="${id}"/>`;

    // Insert from the end of the file backwards so earlier offsets stay valid.
    let next = opf;
    next = next.slice(0, spineClose.index!) + `${ref(lastId)}\n` + next.slice(spineClose.index!);
    next = next.slice(0, frontAt) + `\n${ref(frontId)}` + next.slice(frontAt);
    next =
      next.slice(0, manifestClose.index!) +
      `${item(frontId, frontName)}\n${item(lastId, lastName)}\n` +
      next.slice(manifestClose.index!);

    // Check the result: each new id is in the manifest and the spine
    // exactly once, outside any comment, in the right place.
    if (!injectionLanded(next, [frontId, lastId])) return unsupported();

    zip.file(opfPath, next);
    zip.file(`${dir}${frontName}`, frontPageXhtml(pages.front, epub2));
    zip.file(`${dir}${lastName}`, lastPageXhtml(pages.last, epub2));
    const out = await zip.generateAsync({ type: "nodebuffer" });
    return { added: true, bytes: out };
  } catch {
    return { added: false, bytes, failureStage: "unexpected_exception" };
  }
}
