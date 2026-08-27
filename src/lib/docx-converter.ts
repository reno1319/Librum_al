import JSZip from "jszip";
import mammoth from "mammoth";
import { preflightZipEntries, findEntry } from "@/lib/zip-preflight";

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
    | "unsafe_link_removed";
  message: string;
};

export type DocxConversionResult =
  | {
      success: true;
      sections: DocSection[];
      images: DocImage[];
      warnings: ConversionWarning[];
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
        const href = getAttr(attrs, "href");
        const safe = href && isSafeHref(href);
        if (!safe && href) onUnsafeLink();
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
        const alt = getAttr(attrs, "alt") ?? "";
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
      stack.push({
        tag: name,
        allowed,
        isDropped: false,
        openTag: allowed ? `<${name}>` : "",
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
];

export async function convertDocxToDocument(bytes: Buffer): Promise<DocxConversionResult> {
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

  const warnings: ConversionWarning[] = [];
  const images: DocImage[] = [];
  let totalImageBytes = 0;
  let skippedForCount = false;

  let rawHtml: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: bytes },
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
              message: "An embedded image used an unsupported format and was skipped.",
            });
            return { src: "" };
          }
          const imageBuffer = Buffer.from(await image.read("base64"), "base64");
          if (imageBuffer.length > MAX_SINGLE_IMAGE_BYTES) {
            warnings.push({
              code: "image_skipped_too_large",
              message: "An embedded image was too large and was skipped.",
            });
            return { src: "" };
          }
          if (totalImageBytes + imageBuffer.length > MAX_TOTAL_IMAGE_BYTES) {
            warnings.push({
              code: "image_skipped_too_large",
              message: "The manuscript's embedded images exceeded the total size allowed and some were skipped.",
            });
            return { src: "" };
          }
          totalImageBytes += imageBuffer.length;
          const extension = mediaType === "image/png" ? "png" : mediaType === "image/gif" ? "gif" : "jpg";
          const filename = `img-${images.length + 1}.${extension}`;
          images.push({ filename, mediaType, bytes: imageBuffer });
          return { src: `../images/${filename}` };
        }),
      },
    );
    rawHtml = result.value;

    if (result.messages.some((m) => m.type === "warning")) {
      warnings.push({
        code: "unsupported_element_skipped",
        message: "Some Word-specific formatting couldn't be converted and was simplified.",
      });
    }
  } catch {
    return { success: false, error: "conversion_failed" };
  }

  if (skippedForCount) {
    warnings.push({
      code: "too_many_images",
      message: "This manuscript has more embedded images than Librum can convert; some were skipped.",
    });
  }

  if (!rawHtml || !rawHtml.trim()) {
    return { success: false, error: "empty_document" };
  }

  if (/<table\b/i.test(rawHtml)) {
    warnings.push({
      code: "table_present",
      message: "Tables were converted, but complex tables may need review after conversion.",
    });
  }

  if (await hasFootnotesOrEndnotes(zip)) {
    warnings.push({
      code: "footnotes_or_endnotes_skipped",
      // LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: unambiguous, not
      // hedged -- notes are definitely omitted (see the sanitizer's own
      // footnote-id-based removal above), never merely "may need
      // review." This exact wording was specified in the correction
      // brief.
      message:
        "Footnotes or endnotes were detected. They are not preserved in DOCX conversion yet. Review the generated EPUB before publishing.",
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
  const rawSections: { heading: string | null; rawHtml: string }[] = [];
  let currentHeading: string | null = null;
  let currentHtml = "";

  function flushRaw() {
    if (currentHtml.trim().length > 0 || currentHeading) {
      rawSections.push({ heading: currentHeading, rawHtml: currentHtml });
    }
  }

  for (const part of rawParts) {
    const headingMatch = part.match(/^<h1>([\s\S]*?)<\/h1>$/);
    if (headingMatch) {
      flushRaw();
      currentHeading = headingMatch[1].replace(/<[^>]+>/g, "").trim();
      currentHtml = "";
    } else {
      currentHtml += part;
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
  const sections: DocSection[] = rawSections.map((section) => ({
    heading: section.heading,
    html: sanitizeFragment(
      section.rawHtml,
      (src) => {
        // src is already exactly what our own convertImage callback
        // returned ("../images/img-N.ext") or "" for a skipped image --
        // never anything else, since Mammoth never invents an <img> tag
        // on its own. Re-validated against the images this run actually
        // produced anyway, rather than trusted blindly.
        const filename = src.replace(/^\.\.\/images\//, "");
        return imageFilenames.has(filename) ? src : null;
      },
      () => {
        unsafeLinkFound = true;
      },
    ),
  }));

  if (unsafeLinkFound) {
    warnings.push({
      code: "unsafe_link_removed",
      message: "One or more links used an unsupported address type and were removed.",
    });
  }

  return { success: true, sections, images, warnings };
}
