import JSZip from "jszip";
import mammoth from "mammoth";
import { preflightZipEntries, findEntry } from "@/lib/zip-preflight";
import {
  cleanUpDocx,
  cleanupPassEnabled,
  emptyCleanupReport,
  PARAGRAPH_MARK_PREFIX,
  SCENE_BREAK_MARK_PREFIX,
  type CleanupOptions,
  type CleanupReport,
} from "@/lib/docx-cleanup";
import { ENDNOTES_HEADING, extractNotes, renderNotes, takeHeadingNotes } from "@/lib/docx-notes";
import { findMissingLetters, fixBrokenLetters } from "@/lib/docx-letters";
import { chapterFilename } from "@/lib/epub-generator";

// LIBRUM 2.0 PRODUCT-5: DOCX -> a small, safe, deterministic internal
// document model, entirely separate from EPUB packaging itself (see
// epub-generator.ts, which turns this model into a real EPUB). Chosen
// parser: Mammoth (mwilliamson/mammoth.js, BSD-2-Clause, pure
// JavaScript -- no native binaries, no LibreOffice, no Office
// automation, actively maintained). Mammoth's own design goal is
// exactly this feature's: it converts DOCX using the document's
// SEMANTIC structure (paragraph/character styles) into a small, clean
// HTML subset, deliberately discarding Word-specific visual geometry
// (margins, page size, headers/footers, absolute layout) rather than
// attempting pixel fidelity -- see the PRODUCT-5 audit for the full
// evaluation against implementing OOXML parsing directly (rejected:
// reinventing a mature, already-vetted parser for no product benefit).
//
// Threat model: a DOCX is an untrusted upload, same class of risk as
// any EPUB accepted by this app (see epub-sample.ts's own tokenizer
// for the established precedent) -- so even though Mammoth's own HTML
// output is well-formed and comes from a controlled semantic mapping
// (not a raw pass-through of arbitrary Word HTML/CSS), this module
// still re-sanitizes that output through an explicit tag/attribute
// allowlist before it's ever considered safe to embed in a generated
// EPUB. No macro execution, no external resource fetches (Mammoth's
// own image handling here is wired through convertImage() to read
// embedded relationship bytes only -- see extractImages below -- never
// a network request), no Office/LibreOffice process.

export type DocSection = {
  // The section's own Heading 1 text, or null for a leading section
  // with no heading yet (content before the manuscript's first Heading
  // 1, if any) -- never fabricated from anything else.
  heading: string | null;
  // W3: when the chapter title is shown on two lines in the book
  // ("Kapitulli 1" / "Mëngjesi"), the lines; `heading` is then the
  // one-line contents-list text ("Kapitulli 1: Mëngjesi").
  headingLines?: string[];
  // W3 Part 2 (answer 3a): the note links on the chapter title
  // ("PARATHËNIE¹"), Librum's own markup built from numbers only;
  // shown after the title in the book, never in the contents list.
  headingNotes?: string;
  // Sanitized, well-formed XHTML body content for this chapter --
  // ready to embed directly inside a <body> element.
  html: string;
};

export type DocImage = {
  // Deterministic, generator-assigned name -- never derived from
  // anything in the DOCX itself (embedded image part names are
  // implementation details of Word's own OOXML packaging, not
  // trustworthy or meaningful identifiers).
  filename: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif";
  bytes: Buffer;
};

export type ConversionWarning = {
  code:
    | "footnotes_or_endnotes_skipped"
    | "table_present"
    | "image_skipped_unsupported_type"
    | "image_skipped_too_large"
    | "too_many_images"
    | "unsupported_element_skipped"
    | "unsafe_link_removed"
    | "tracked_changes_accepted";
  message: string;
};

// W4: the same chapters as `sections`, one for one, for the author's
// preview. `html` is the same sanitized content plus empty
// <span data-p="N"> (start of Word paragraph N) and <span data-s="N">
// (scene break before Word paragraph N) marks; `headingPara` is the
// Word paragraph of the chapter title. Never put in the ebook.
export type PreviewSection = {
  heading: string | null;
  headingLines?: string[];
  headingNotes?: string;
  headingPara: number | null;
  html: string;
};

export type DocxConversionResult =
  | {
      success: true;
      sections: DocSection[];
      images: DocImage[];
      warnings: ConversionWarning[];
      // W3: what the clean-up pass changed and guessed (for the author
      // preview, W4).
      cleanup: CleanupReport;
      // W4: only when asked for ({ preview: true }).
      preview?: PreviewSection[];
    }
  | {
      success: false;
      // A short, generic, author-safe reason -- never a raw parser
      // exception message or stack trace (see the PRODUCT-5 brief's
      // own "do not expose parser stack traces" requirement).
      error:
        | "invalid_zip"
        | "not_a_docx"
        | "macro_enabled_document_not_supported"
        | "empty_document"
        | "conversion_failed"
        | "too_large_uncompressed"
        | "too_complex";
    };

// LIBRUM 2.0 PRODUCT-5: mirrors MAX_MANUSCRIPT_BYTES in
// src/app/dashboard/books/actions.ts -- the DOCX upload itself is
// already bounded there before this module ever sees it; these are
// additional backstops on what conversion produces/processes, same
// "defense in depth, not the only bound" philosophy epub-sample.ts's
// own MAX_SPINE_ITEMS/MAX_DOCUMENT_CHARS already establish.
const MAX_HTML_CHARS = 5_000_000;
const MAX_IMAGES = 200;
const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;
const MAX_SINGLE_IMAGE_BYTES = 15 * 1024 * 1024;

// LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: pre-inflation ZIP-bomb
// bounds -- see zip-preflight.ts for why these can be enforced from
// the ZIP's own central directory, before Mammoth (or JSZip's own
// `.async()`) ever decompresses anything. Chosen with real headroom
// above what an ordinary, even heavily-illustrated, novel-length
// manuscript needs, while still being a genuine, bounded ceiling:
//   - MAX_DOCX_ENTRIES: a legitimate manuscript DOCX -- structural
//     parts (document/styles/numbering/theme/relationships) plus one
//     media part per embedded image -- realistically has tens to a
//     few hundred entries even with hundreds of images. 5,000 gives
//     an order of magnitude of headroom while still bounding an
//     entry-count-flood attempt.
//   - MAX_DOCX_UNCOMPRESSED_BYTES: aggregate across every part. The
//     compressed upload is already capped at 50MB (MAX_MANUSCRIPT_BYTES
//     in actions.ts); XML text and already-compressed image formats
//     (PNG/JPEG) rarely expand more than a few times over on top of
//     that. 300MB is a generous ~6x allowance for a genuinely large
//     manuscript, while real zip-bomb payloads typically claim ratios
//     in the hundreds or thousands.
//   - MAX_DOCUMENT_XML_BYTES: word/document.xml alone -- even a very
//     long (500,000+ word) novel's document.xml, including Word's own
//     run-splitting verbosity, is realistically low tens of MB. 50MB
//     is generous headroom.
//   - MAX_XML_PART_BYTES: the same ceiling applied to any other single
//     XML part (styles.xml, footnotes.xml, ...), which in practice are
//     always far smaller than document.xml -- kept at the same bound
//     for a simple, consistent rule rather than a separate number per
//     part type.
const MAX_DOCX_ENTRIES = 5_000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
const MAX_DOCUMENT_XML_BYTES = 50 * 1024 * 1024;
const MAX_XML_PART_BYTES = 50 * 1024 * 1024;

// W2: the image path written into chapter pages, relative to the
// chapter file. epub-generator.ts writes chapters to OEBPS/ and images
// to OEBPS/images/, so this must stay "images/".
export const IMAGE_SRC_PREFIX = "images/";

const SUPPORTED_IMAGE_TYPES: Record<string, DocImage["mediaType"]> = {
  "image/png": "image/png",
  "image/jpeg": "image/jpeg",
  "image/gif": "image/gif",
};

// LIBRUM 2.0 PRODUCT-5: a DOCX renamed from .docm (or a .docx that
// somehow still carries a macro project part) is rejected outright --
// V1 accepts .docx only, never executes or interprets macro content,
// and this is the one signal actually worth checking INSIDE the file
// (the extension itself is checked by the caller, but a renamed file
// extension proves nothing about content -- see section 37/38 of the
// brief). word/vbaProject.bin is the fixed, well-known OOXML part name
// for an embedded VBA macro project; its mere presence is the signal,
// regardless of what it contains -- this module never opens or parses
// it.
async function containsMacroProject(zip: JSZip): Promise<boolean> {
  return zip.file("word/vbaProject.bin") !== null;
}

// Minimum structural validity check -- same spirit as
// epub-validation.ts's own "real ZIP with the required entries"
// bar, not full OOXML conformance validation. Rejects a spoofed
// arbitrary ZIP renamed .docx before ever handing it to Mammoth.
async function looksLikeDocx(zip: JSZip): Promise<boolean> {
  return zip.file("[Content_Types].xml") !== null && zip.file("word/document.xml") !== null;
}

async function hasFootnotesOrEndnotes(zip: JSZip): Promise<boolean> {
  for (const path of ["word/footnotes.xml", "word/endnotes.xml"]) {
    const file = zip.file(path);
    if (!file) continue;
    try {
      const xml = await file.async("string");
      // A DOCX always carries these parts even with zero real
      // footnotes (Word's own template separator/continuation-notice
      // placeholders) -- a real, note-bearing document is
      // distinguished by an actual <w:footnote>/<w:endnote> element
      // beyond that fixed boilerplate, which this checks for directly
      // rather than assuming presence-of-file alone means content.
      if (/<w:(footnote|endnote)\b[^>]*\bw:id="(?!-?[01])/i.test(xml)) {
        return true;
      }
    } catch {
      // Unreadable notes part -- not fatal to the whole conversion,
      // just can't confirm one way or the other; treated as "none
      // detected" rather than failing the conversion over it.
    }
  }
  return false;
}

// W3 Part 2 (audit F3): the notes the text points at, as "f5" / "e3",
// read straight from Word's own XML. When one of these did not come
// through as a note (a shape the note code does not know), the author
// still gets the "notes left out" warning instead of losing it silently.
// References deleted with Track Changes (w:del, or the old place of a
// move, w:moveFrom) are not in the book, so they never count (audit r2
// F5); a self-closing w:del only marks a deleted paragraph end.
const DELETED_XML_RE = /<w:(del|moveFrom)\b[^>]*\/>|<w:(del|moveFrom)\b(?:[^>]*[^>/])?>[\s\S]*?<\/w:\2>/g;
async function referencedNoteKeys(zip: JSZip): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const xml = ((await zip.file("word/document.xml")?.async("string")) ?? "").replace(DELETED_XML_RE, "");
    for (const m of xml.matchAll(/<w:(footnote|endnote)Reference\b[^>]*?\bw:id="(-?\d+)"/g)) {
      keys.add(`${m[1] === "footnote" ? "f" : "e"}${m[2]}`);
    }
  } catch {
    // Unreadable: nothing to compare against.
  }
  return keys;
}

const SAFE_LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);

function isSafeHref(href: string): boolean {
  try {
    // A relative/internal bookmark link (e.g. "#_Toc123") has no
    // scheme at all -- URL() would throw parsing it against no base,
    // which is exactly right: internal bookmarks are omitted in V1
    // (see the brief's own "internal document bookmarks may be
    // omitted in V1 if difficult"), not rewritten or guessed at.
    const url = new URL(href);
    return SAFE_LINK_SCHEMES.has(url.protocol);
  } catch {
    return false;
  }
}

function isWordTocBookmark(href: string): boolean {
  return /^#_Toc[\w-]*$/.test(href);
}

// W2: Mammoth reports every Word style it has no mapping for. These
// styles carry no content Librum loses (the text still comes through
// as ordinary paragraphs, and Librum builds its own contents page), so
// they must not trigger the "some formatting couldn't be converted"
// warning. Anything else Mammoth warns about still does.
const HARMLESS_PARAGRAPH_STYLES = [/^title$/i, /^toc\b/i, /^body text$/i, /^first paragraph$/i];
const HARMLESS_RUN_STYLES = [/^hyperlink$/i];

export function isHarmlessMammothWarning(message: string): boolean {
  // Greedy up to Mammoth's own " (Style ID: " suffix, so a style name
  // containing an apostrophe is read whole.
  const style = message.match(/^Unrecognised (paragraph|run) style: '(.*)' \(Style ID: /);
  if (style) {
    const list = style[1] === "paragraph" ? HARMLESS_PARAGRAPH_STYLES : HARMLESS_RUN_STYLES;
    return list.some((re) => re.test(style[2].trim()));
  }
  // An image in a format Librum doesn't keep already gets its own,
  // clearer warning ("image_skipped_unsupported_type").
  return /^Image of type .* is unlikely to display in web browsers$/.test(message);
}

// W2: Mammoth's heading HTML is already escaped ("Ana &amp; Beni").
// The heading is stored as plain text and epub-generator.ts escapes it
// once when writing it, so it is decoded here exactly once.
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// W3: a footnote number on a chapter title ("PARATHËNIE¹") stays out
// of the title text used for the contents list.
const NOTE_REF_RE = /<a\b[^>]*\bid="(?:footnote|endnote)-ref-\d+"[^>]*>[\s\S]*?<\/a>/g;

export function headingHtmlToText(html: string): string {
  return decodeEntities(html.replace(NOTE_REF_RE, "").replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

// W2: removes elements left with nothing inside them -- the empty <p>
// a skipped image or a bookmark leaves behind, the empty <sup> where a
// removed footnote number was, the empty <ol> the removed note list
// leaves. The sanitizer emits these tags without attributes, so a
// plain match is exact. Repeated until nothing changes, so nested
// empties (<p><em></em></p>) go too. Table cells are never removed
// (that would break the table's shape). An empty inline element keeps
// any space it held ("word<em> </em>word" stays two words). Only plain
// spaces, tabs and line breaks count as empty -- never a non-breaking
// space (U+00A0 or &nbsp;): a paragraph holding just that is a blank
// line the author put there on purpose (a scene break, a stanza gap),
// and an inline one must stay non-breaking. JavaScript's \s would match
// U+00A0, so it is not used here.
const EMPTY_ELEMENT_RE = /<(p|sup|sub|ol|ul|li|em|strong|i|b|u|blockquote|h2|h3|h4)>([ \t\r\n]*)<\/\1>/g;
const INLINE_TAGS = new Set(["sup", "sub", "em", "strong", "i", "b", "u"]);
export function removeEmptyElements(html: string): string {
  let current = html;
  for (;;) {
    const next = current.replace(EMPTY_ELEMENT_RE, (_whole, tag: string, space: string) =>
      INLINE_TAGS.has(tag) && space.length > 0 ? " " : "",
    );
    if (next === current) return current;
    current = next;
  }
}

// W3: "Kapitulli 1" + "Mëngjesi" -> "Kapitulli 1: Mëngjesi" for the
// contents list; other two-line titles are joined with a space.
const HEADING_LABEL_RE =
  /^(?:(?:kapitull(?:i)?|kreu|pjesa|libri|tregimi|chapter|part|book)\s+(?:[ie]\s+)?\S{1,12}|[IVXLCDM]{1,7}\.?|\d{1,3}\.?)$/i;
export function headingFromHtml(html: string): { heading: string | null; lines?: string[] } {
  const lines = html
    .replace(NOTE_REF_RE, "")
    .split(/<br\s*\/?>/i)
    .map((l) => headingHtmlToText(l))
    .filter(Boolean);
  if (lines.length === 0) return { heading: null };
  if (lines.length === 1) return { heading: lines[0] };
  const [first, ...rest] = lines;
  const heading = HEADING_LABEL_RE.test(first)
    ? `${first.replace(/[.:]$/, "")}: ${rest.join(" ")}`
    : lines.join(" ");
  return { heading, lines };
}

function hasVisibleContent(html: string): boolean {
  return /<img\b|<hr\b|<table\b/.test(html) || html.replace(/<[^>]+>/g, "").trim().length > 0;
}

// ============================================================
// Sanitizer -- mirrors epub-sample.ts's own stack-based tokenizer
// architecture (the established, already-reviewed pattern in this
// codebase for "untrusted markup in, small safe tag vocabulary out"),
// extended here with the two things a full manuscript legitimately
// needs that a reading SAMPLE deliberately omits: hyperlinks and
// images. Every allowed tag keeps zero attributes except the two
// explicitly listed below (a[href], img[src+alt]) -- never a generic
// attribute passthrough.
// ============================================================

const ALLOWED_TAGS = new Set([
  "p", "h2", "h3", "h4", "blockquote",
  "em", "strong", "i", "b", "u", "br", "hr",
  "ul", "ol", "li", "sup", "sub",
  "a", "img",
  "table", "thead", "tbody", "tr", "td", "th",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
// W3: the only class names kept -- the ones docx-converter's own style
// map writes for the clean-up pass's marks. Anything else is dropped.
const ALLOWED_P_CLASSES = new Set(["scene-break", "center", "right", "verse", "verse-stanza", "verse-indent", "gap"]);
const DROP_ENTIRELY_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "option", "video", "audio", "canvas", "svg",
  "template", "noscript", "head", "title", "meta", "link", "base",
]);

const TOKEN_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function getAttr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? match[2] : null;
}

type StackFrame = {
  tag: string;
  allowed: boolean;
  isDropped: boolean;
  openTag: string;
  html: string[];
};

function sanitizeFragment(
  rawHtml: string,
  imageSrcRewrite: (originalSrc: string) => string | null,
  onUnsafeLink: () => void,
): string {
  const capped = rawHtml.length > MAX_HTML_CHARS ? rawHtml.slice(0, MAX_HTML_CHARS) : rawHtml;
  const root: StackFrame = { tag: "#root", allowed: false, isDropped: false, openTag: "", html: [] };
  const stack: StackFrame[] = [root];

  function isInsideDrop(): boolean {
    return stack.some((f) => f.isDropped);
  }
  function appendText(raw: string) {
    if (!raw || isInsideDrop()) return;
    stack[stack.length - 1].html.push(raw);
  }

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(capped))) {
    appendText(capped.slice(lastIndex, match.index));
    lastIndex = TOKEN_RE.lastIndex;
    const [, closeName, openName, rawAttrs, selfCloseMark] = match;

    if (closeName) {
      const name = closeName.toLowerCase();
      const idx = stack.map((f) => f.tag).lastIndexOf(name);
      if (idx === -1) continue;
      while (stack.length > idx) {
        const finished = stack.pop()!;
        const parent = stack[stack.length - 1];
        if (finished.isDropped) continue;
        const rendered = finished.allowed
          ? `${finished.openTag}${finished.html.join("")}</${finished.tag}>`
          : finished.html.join("");
        parent.html.push(rendered);
      }
      continue;
    }

    if (openName) {
      const name = openName.toLowerCase();
      const selfClosing = selfCloseMark === "/" || VOID_TAGS.has(name);

      if (isInsideDrop() || DROP_ENTIRELY_TAGS.has(name)) {
        if (!selfClosing) stack.push({ tag: name, allowed: false, isDropped: true, openTag: "", html: [] });
        continue;
      }

      const attrs = rawAttrs ?? "";

      // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: Mammoth DOES
      // convert footnotes/endnotes -- verified empirically, not
      // assumed -- as a superscript reference link
      // (<sup><a href="#footnote-2" id="footnote-ref-2">[1]</a></sup>)
      // plus a single <ol> of note text appended at the very END of
      // the WHOLE document, with matching <li id="footnote-2"> targets
      // and "back to reference" links. That shape only works as a
      // single unsplit HTML document -- this converter splits the
      // manuscript into one XHTML file per Heading-1 chapter, so a
      // reference in chapter 1 and its note text collected at the very
      // end (wherever the last chapter happens to land) would be an
      // internal anchor link pointing at a DIFFERENT EPUB content
      // document, which EPUB readers cannot follow (XHTML fragment
      // navigation is same-document only). Reliably relocating the
      // note list per chapter and rewriting every cross-file link is
      // exactly the "large note-conversion implementation" this pass
      // was told not to build. V1 decision: cleanly remove Mammoth's
      // own footnote/endnote reference and list markup by its own
      // well-known, stable id convention (never left as a dead link or
      // an orphaned "[1]" marker) and rely on hasFootnotesOrEndnotes()
      // below for an unambiguous, always-present warning instead.
      const idAttr = getAttr(attrs, "id");
      const isFootnoteRefLink = name === "a" && idAttr && /^(?:footnote|endnote)-ref-\d+$/.test(idAttr);
      if (isFootnoteRefLink) {
        if (!selfClosing) stack.push({ tag: name, allowed: false, isDropped: true, openTag: "", html: [] });
        continue;
      }

      if (name === "a") {
        // W3: Mammoth's HTML is already escaped ("a=1&amp;b=2"); decoded
        // once here so escapeAttr() below doesn't make it "&amp;amp;".
        const rawHref = getAttr(attrs, "href");
        const href = rawHref === null ? null : decodeEntities(rawHref);
        const safe = href && isSafeHref(href);
        // W2: Word's own table-of-contents links ("#_Toc...") point at
        // bookmarks inside the document. They are unwrapped (text kept)
        // like any other non-web link, but they are not unsafe, so they
        // no longer raise the "unsafe link" warning.
        if (!safe && href && !isWordTocBookmark(href)) onUnsafeLink();
        const openTag = safe ? `<a href="${escapeAttr(href!)}">` : "";
        if (selfClosing) continue;
        stack.push({ tag: name, allowed: safe === true, isDropped: false, openTag, html: [] });
        continue;
      }

      const isFootnoteListItem = name === "li" && idAttr && /^(?:footnote|endnote)-\d+$/.test(idAttr);
      if (isFootnoteListItem) {
        if (!selfClosing) stack.push({ tag: name, allowed: false, isDropped: true, openTag: "", html: [] });
        continue;
      }

      if (name === "img") {
        const src = getAttr(attrs, "src");
        const alt = decodeEntities(getAttr(attrs, "alt") ?? "");
        const rewritten = src ? imageSrcRewrite(src) : null;
        if (rewritten) {
          stack[stack.length - 1].html.push(
            `<img src="${escapeAttr(rewritten)}" alt="${escapeAttr(alt)}"/>`,
          );
        }
        continue;
      }

      if (VOID_TAGS.has(name)) {
        stack[stack.length - 1].html.push(`<${name}/>`);
        continue;
      }

      if (selfClosing) continue;

      const allowed = ALLOWED_TAGS.has(name);
      const pClass = name === "p" ? getAttr(attrs, "class") : null;
      const keptClass = pClass && ALLOWED_P_CLASSES.has(pClass) ? pClass : null;
      stack.push({
        tag: name,
        allowed,
        isDropped: false,
        openTag: allowed ? (keptClass ? `<p class="${keptClass}">` : `<${name}>`) : "",
        html: [],
      });
      continue;
    }
  }
  appendText(capped.slice(lastIndex));

  // Any frame still open at end-of-document (malformed input) simply
  // never gets flushed into its parent -- same "whatever cleanly
  // closed is kept, nothing else is guessed at" rule epub-sample.ts's
  // own tokenizer uses.
  return root.html.join("");
}

// ============================================================
// Mammoth wiring
// ============================================================

const HEADING_STYLE_MAP = [
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote:fresh",
  // W3: marks written by the clean-up pass (docx-cleanup.ts).
  "p[style-name='Librum Chapter'] => h1:fresh",
  "p[style-name='Librum Subheading'] => h2:fresh",
  "p[style-name='Librum Scene Break'] => p.scene-break:fresh",
  "p[style-name='Librum Center'] => p.center:fresh",
  "p[style-name='Librum Right'] => p.right:fresh",
  "p[style-name='Librum Verse'] => p.verse:fresh",
  "p[style-name='Librum Verse Stanza'] => p.verse-stanza:fresh",
  "p[style-name='Librum Verse Indent'] => p.verse-indent:fresh",
  "p[style-name='Librum Plain'] => p:fresh",
  "p[style-name='Librum Gap'] => p.gap:fresh",
];

// W4: Mammoth writes the clean-up pass's paragraph marks as empty
// anchors. They are taken out of the ebook's HTML before anything else
// sees it; the preview keeps them as private-use characters (which pass
// the sanitizer as text) and turns them into data spans afterwards.
const MARK_ANCHOR_RE = new RegExp(`<a id="(${PARAGRAPH_MARK_PREFIX}|${SCENE_BREAK_MARK_PREFIX})(\\d{1,7})"></a>`, "g");
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const MARK_TEXT_RE = /\uE000([ps])(\d{1,7})\uE001/g;
const PRIVATE_MARK_CHARS_RE = /[\uE000\uE001]/g;

export function stripParagraphMarks(html: string): string {
  return html.replace(MARK_ANCHOR_RE, "");
}

function marksToText(html: string): string {
  return html
    .replace(PRIVATE_MARK_CHARS_RE, "")
    .replace(MARK_ANCHOR_RE, (_m, prefix: string, n: string) =>
      `${MARK_OPEN}${prefix === PARAGRAPH_MARK_PREFIX ? "p" : "s"}${n}${MARK_CLOSE}`,
    );
}

function marksToSpans(html: string): string {
  return html.replace(MARK_TEXT_RE, (_m, kind: string, n: string) =>
    kind === "p" ? `<span data-p="${Number(n)}"></span>` : `<span data-s="${Number(n)}"></span>`,
  );
}

function firstParagraphMark(html: string): number | null {
  for (const m of html.matchAll(MARK_ANCHOR_RE)) {
    if (m[1] === PARAGRAPH_MARK_PREFIX) return Number(m[2]);
  }
  return null;
}

export type ConvertExtras = {
  // W4: also return the chapters with paragraph marks for the preview.
  preview?: boolean;
};

export async function convertDocxToDocument(
  bytes: Buffer,
  options: CleanupOptions = {},
  extras: ConvertExtras = {},
): Promise<DocxConversionResult> {
  // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: the ZIP-bomb preflight
  // runs FIRST, against the raw buffer, before JSZip (or Mammoth,
  // which is layered on top of it) ever touches this file. See
  // zip-preflight.ts for why this is the one check capable of bounding
  // uncompressed size before any inflation happens.
  const preflight = preflightZipEntries(bytes, {
    maxEntries: MAX_DOCX_ENTRIES,
    maxTotalUncompressedBytes: MAX_DOCX_UNCOMPRESSED_BYTES,
  });
  if (!preflight.ok) {
    if (preflight.reason === "not_a_zip") {
      return { success: false, error: "invalid_zip" };
    }
    if (preflight.reason === "too_many_entries") {
      return { success: false, error: "too_complex" };
    }
    return { success: false, error: "too_large_uncompressed" };
  }

  const documentXmlEntry = findEntry(preflight.entries, "word/document.xml");
  if (documentXmlEntry && documentXmlEntry.uncompressedSize > MAX_DOCUMENT_XML_BYTES) {
    return { success: false, error: "too_large_uncompressed" };
  }
  for (const entry of preflight.entries) {
    if (entry.name.endsWith(".xml") && entry.uncompressedSize > MAX_XML_PART_BYTES) {
      return { success: false, error: "too_large_uncompressed" };
    }
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { success: false, error: "invalid_zip" };
  }

  if (!(await looksLikeDocx(zip))) {
    return { success: false, error: "not_a_docx" };
  }

  if (await containsMacroProject(zip)) {
    return { success: false, error: "macro_enabled_document_not_supported" };
  }

  // W3: the clean-up pass writes a cleaned copy for Mammoth. Any failure
  // there (an unusual or malformed file) falls back to converting the
  // original exactly as before.
  let mammothInput = bytes;
  let cleanup = emptyCleanupReport();
  const w3Enabled = cleanupPassEnabled();
  if (w3Enabled) {
    try {
      const copy = await JSZip.loadAsync(bytes);
      cleanup = await cleanUpDocx(copy, { ...options, markParagraphs: extras.preview === true });
      if (cleanup.applied) {
        mammothInput = await copy.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
      }
    } catch {
      cleanup = emptyCleanupReport();
      mammothInput = bytes;
    }
  }

  const warnings: ConversionWarning[] = [];
  if (cleanup.trackedChanges || cleanup.comments) {
    warnings.push({
      code: "tracked_changes_accepted",
      message:
        "Dokumenti kishte ndryshime të pashqyrtuara (Track Changes) ose komente. U përdor versioni përfundimtar, me të gjitha ndryshimet të pranuara dhe pa komente. Kontrollojeni tekstin.",
    });
  }
  const images: DocImage[] = [];
  let totalImageBytes = 0;
  let skippedForCount = false;

  let rawHtml: string;
  let markedHtml: string | null = null;
  let noteBodies = new Map<string, string>();
  try {
    const result = await mammoth.convertToHtml(
      { buffer: mammothInput },
      {
        styleMap: HEADING_STYLE_MAP,
        // LIBRUM 2.0 PRODUCT-5: the ONLY place image bytes ever come
        // from -- Mammoth hands this callback the embedded image part
        // it already read out of the DOCX's own ZIP relationships.
        // Never a URL, never a network fetch -- an image DOCX field
        // that references an EXTERNAL link (rather than an embedded
        // part) never reaches this callback at all, which is exactly
        // the "do not fetch remote DOCX-linked assets" requirement.
        convertImage: mammoth.images.imgElement(async (image) => {
          if (images.length >= MAX_IMAGES) {
            skippedForCount = true;
            return { src: "" };
          }
          const mediaType = SUPPORTED_IMAGE_TYPES[image.contentType];
          if (!mediaType) {
            warnings.push({
              code: "image_skipped_unsupported_type",
              message: "Një imazh brenda dokumentit ishte në format të papranuar dhe u la jashtë.",
            });
            return { src: "" };
          }
          const imageBuffer = Buffer.from(await image.read("base64"), "base64");
          if (imageBuffer.length > MAX_SINGLE_IMAGE_BYTES) {
            warnings.push({
              code: "image_skipped_too_large",
              message: "Një imazh brenda dokumentit ishte shumë i madh dhe u la jashtë.",
            });
            return { src: "" };
          }
          if (totalImageBytes + imageBuffer.length > MAX_TOTAL_IMAGE_BYTES) {
            warnings.push({
              code: "image_skipped_too_large",
              message: "Imazhet brenda dorëshkrimit e kaluan madhësinë e lejuar gjithsej dhe disa u lanë jashtë.",
            });
            return { src: "" };
          }
          totalImageBytes += imageBuffer.length;
          const extension = mediaType === "image/png" ? "png" : mediaType === "image/gif" ? "gif" : "jpg";
          const filename = `img-${images.length + 1}.${extension}`;
          images.push({ filename, mediaType, bytes: imageBuffer });
          // W2: chapters sit in OEBPS/ next to OEBPS/images/, so the
          // path is "images/x" -- the old "../images/x" pointed outside
          // OEBPS and every converted picture was broken.
          return { src: `${IMAGE_SRC_PREFIX}${filename}` };
        }),
      },
    );
    // W4: the ebook never carries the preview's marks (removed here,
    // before anything else reads the HTML); the marked copy is kept
    // only for the preview.
    let mammothHtml = result.value;
    // W3 Part 2 (answer 6a): broken letters ("Ã«" -> "ë"), and notes
    // taken out before the chapter split (docx-notes.ts). Both only with
    // the clean-up pass on (answer 2a: one switch for all of W3).
    if (w3Enabled) {
      const fixed = fixBrokenLetters(mammothHtml);
      mammothHtml = fixed.text;
      cleanup.fixes.brokenLetters = fixed.count;
      const extracted = extractNotes(mammothHtml);
      mammothHtml = extracted.html;
      noteBodies = extracted.bodies;
    }
    markedHtml = extras.preview ? mammothHtml : null;
    rawHtml = stripParagraphMarks(mammothHtml);

    if (result.messages.some((m) => m.type === "warning" && !isHarmlessMammothWarning(m.message))) {
      warnings.push({
        code: "unsupported_element_skipped",
        message: "Disa formatime të veçanta të Word-it nuk u kthyen dot dhe u thjeshtuan.",
      });
    }
  } catch {
    return { success: false, error: "conversion_failed" };
  }

  if (skippedForCount) {
    warnings.push({
      code: "too_many_images",
      message: "Ky dorëshkrim ka më shumë imazhe nga sa mund të kthejë Librum; disa u lanë jashtë.",
    });
  }

  if (!rawHtml || !rawHtml.trim()) {
    return { success: false, error: "empty_document" };
  }

  if (/<table\b/i.test(rawHtml)) {
    warnings.push({
      code: "table_present",
      message: "Tabelat u kthyen, por tabelat e ndërlikuara mund të duhen kontrolluar pas kthimit.",
    });
  }

  if (!w3Enabled && (await hasFootnotesOrEndnotes(zip))) {
    warnings.push({
      code: "footnotes_or_endnotes_skipped",
      // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: unambiguous, not
      // hedged -- notes are definitely omitted (see the sanitizer's own
      // footnote-id-based removal above), never merely "may need
      // review." This exact wording was specified in the correction
      // brief.
      message:
        "U gjetën shënime në fund të faqes ose të librit. Ato ende nuk ruhen gjatë kthimit nga DOCX. Kontrolloni EPUB-in e krijuar para publikimit.",
    });
  }

  // Chapter/section detection: Heading 1 is the only reliable semantic
  // cue this uses (see HEADING_STYLE_MAP above) -- never all-caps
  // paragraphs, font size, or page breaks alone, per the brief's own
  // "do not silently invent structure" rule. No Heading 1 anywhere ->
  // one continuous section, heading null. Split happens on Mammoth's
  // OWN raw <h1> output BEFORE sanitization -- h1 is deliberately not
  // in the sanitizer's ALLOWED_TAGS (a chapter heading is re-added by
  // epub-generator.ts itself from `heading`, never left inline inside
  // `html`, so there's exactly one place a chapter title is ever
  // rendered from), so splitting on it has to happen first.
  const rawParts = rawHtml.split(/(<h1>[\s\S]*?<\/h1>)/);
  // W4: the marked copy splits into exactly the same parts (the marks
  // are only empty anchors); if it ever doesn't, there is no preview
  // marking rather than a wrong one.
  let markedParts = markedHtml !== null ? markedHtml.split(/(<h1>[\s\S]*?<\/h1>)/) : null;
  if (markedParts && markedParts.length !== rawParts.length) markedParts = null;
  const rawSections: {
    heading: string | null;
    headingLines?: string[];
    headingKeys: string[];
    rawHtml: string;
    headingPara: number | null;
    markedHtml: string;
  }[] = [];
  let currentHeading: string | null = null;
  let currentLines: string[] | undefined;
  let currentKeys: string[] = [];
  let currentHtml = "";
  let currentHeadingPara: number | null = null;
  let currentMarked = "";

  function flushRaw() {
    if (currentHtml.trim().length > 0 || currentHeading) {
      rawSections.push({
        heading: currentHeading,
        headingLines: currentLines,
        headingKeys: currentKeys,
        rawHtml: currentHtml,
        headingPara: currentHeadingPara,
        markedHtml: currentMarked,
      });
    }
  }

  for (const [partIndex, part] of rawParts.entries()) {
    const headingMatch = part.match(/^<h1>([\s\S]*?)<\/h1>$/);
    const markedPart = markedParts ? markedParts[partIndex] : "";
    if (headingMatch) {
      flushRaw();
      currentHeadingPara = firstParagraphMark(markedPart);
      currentMarked = "";
      if (w3Enabled) {
        const taken = takeHeadingNotes(headingMatch[1]);
        currentKeys = taken.keys;
        const parsed = headingFromHtml(taken.html);
        currentHeading = parsed.heading;
        currentLines = parsed.lines;
      } else {
        // Answer 10b: Production keeps the title exactly as before W3.
        currentHeading = headingHtmlToText(headingMatch[1]) || null;
        currentLines = undefined;
        currentKeys = [];
      }
      currentHtml = "";
    } else {
      currentHtml += part;
      currentMarked += markedPart;
    }
  }
  flushRaw();

  if (rawSections.length === 0) {
    return { success: false, error: "empty_document" };
  }

  // Sanitized per-section, AFTER the h1 split above -- each section's
  // fragment no longer contains any h1 at this point, so there's no
  // conflict with h1 being outside ALLOWED_TAGS.
  let unsafeLinkFound = false;
  const imageFilenames = new Set(images.map((i) => i.filename));
  const checkImageSrc = (src: string) => {
    // src is already exactly what our own convertImage callback
    // returned ("images/img-N.ext") or "" for a skipped image --
    // never anything else, since Mammoth never invents an <img> tag
    // on its own. Re-validated against the images this run actually
    // produced anyway, rather than trusted blindly.
    if (!src.startsWith(IMAGE_SRC_PREFIX)) return null;
    const filename = src.slice(IMAGE_SRC_PREFIX.length);
    return imageFilenames.has(filename) ? src : null;
  };
  const sanitizedSections: DocSection[] = rawSections.map((section) => ({
    heading: section.heading,
    ...(section.headingLines ? { headingLines: section.headingLines } : {}),
    html: removeEmptyElements(sanitizeFragment(
      section.rawHtml,
      checkImageSrc,
      () => {
        unsafeLinkFound = true;
      },
    )).trim(),
  }));

  // W2: a section with no heading and nothing visible in it (e.g. only
  // a bookmark before the first Heading 1) used to become an empty
  // first page. A titled chapter is always kept, even with no body.
  const keep = sanitizedSections.map((s) => !!s.heading || hasVisibleContent(s.html));
  const sections = sanitizedSections.filter((_s, i) => keep[i]);
  if (sections.length === 0) {
    return { success: false, error: "empty_document" };
  }
  const keptKeys = rawSections.filter((_s, i) => keep[i]).map((s) => s.headingKeys);

  // W3 Part 2: notes. Footnotes go at the end of their own chapter, and
  // endnotes into one "Shënime" chapter after the last one (answer 1b).
  const sanitizeNote = (html: string) =>
    removeEmptyElements(sanitizeFragment(html, checkImageSrc, () => {
      unsafeLinkFound = true;
    }));
  const withNotes = <T extends { html: string; headingNotes?: string }>(list: T[], extra: (html: string) => T) => {
    const rendered = renderNotes(
      list.map((s, i) => ({ html: s.html, headingKeys: keptKeys[i] })),
      noteBodies,
      sanitizeNote,
      chapterFilename,
    );
    const out: T[] = list.map((s, i) => ({
      ...s,
      html: rendered.sections[i].html,
      ...(rendered.sections[i].headingNotes ? { headingNotes: rendered.sections[i].headingNotes } : {}),
    }));
    if (rendered.endnotesHtml) out.push(extra(rendered.endnotesHtml));
    return { out, rendered };
  };
  let finalSections = sections;
  if (w3Enabled) {
    const { out, rendered } = withNotes(sections, (html) => ({ heading: ENDNOTES_HEADING, html }));
    finalSections = out;
    cleanup.notes = { footnotes: rendered.footnotes, endnotes: rendered.endnotes, dropped: rendered.unplaced };
    const unreadable = [...(await referencedNoteKeys(zip))].some((k) => !noteBodies.has(k));
    if (rendered.unplaced > 0 || unreadable) {
      warnings.push({
        code: "footnotes_or_endnotes_skipped",
        message: "Disa shënime nuk u kthyen dot dhe u lanë jashtë. Kontrolloni librin para publikimit.",
      });
    }
    // Answer 5a: words typed without ë/ç, reported only.
    cleanup.missingLetters = findMissingLetters(
      finalSections.flatMap((s) => [s.heading ?? "", headingHtmlToText(s.html.replace(/<\/(?:p|li|h[2-4]|td|th|aside|div)>/g, " "))]),
    );
  }

  // W4: the preview's chapters, one for one with `sections`.
  let preview: PreviewSection[] | undefined;
  if (extras.preview) {
    const previewSections: PreviewSection[] = rawSections.flatMap((section, i) => {
      if (!keep[i]) return [];
      const html = markedParts
        ? marksToSpans(removeEmptyElements(sanitizeFragment(marksToText(section.markedHtml), checkImageSrc, () => {})).trim())
        : sanitizedSections[i].html;
      return [{
        heading: section.heading,
        ...(section.headingLines ? { headingLines: section.headingLines } : {}),
        headingPara: markedParts ? section.headingPara : null,
        html,
      }];
    });
    preview = w3Enabled
      ? withNotes(previewSections, (html) => ({ heading: ENDNOTES_HEADING, headingPara: null, html })).out
      : previewSections;
  }

  if (unsafeLinkFound) {
    warnings.push({
      code: "unsafe_link_removed",
      message: "Një ose më shumë lidhje kishin adresë të papranuar dhe u hoqën.",
    });
  }

  return { success: true, sections: finalSections, images, warnings, cleanup, ...(preview ? { preview } : {}) };
}
