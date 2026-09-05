import JSZip from "jszip";
import { posix } from "node:path";
import { preflightZipEntries } from "@/lib/zip-preflight";
import { EPUB_ZIP_PREFLIGHT_LIMITS } from "@/lib/epub-validation";
import { resolveArchivePath } from "@/lib/epub-archive-paths";

// LIBRUM 2.0 PRODUCT-1: derives a genuine "Read sample" excerpt from a
// book's own EPUB manuscript, on demand, entirely server-side. Chosen
// architecture: ON-DEMAND EXTRACTION, not a precomputed/stored sample --
// see the PRODUCT-1 audit for the full comparison. In short: every book
// already has a structurally-validated manuscript from the moment it's
// created (createBook() requires one; see epub-validation.ts), so
// on-demand works identically for every existing book with zero
// backfill, needs no new storage/migration, and can never go stale
// against a replaced manuscript or a status flip -- the caller (the
// sample API route) re-checks `status === "published"` on every
// request, the same way Book Detail's own visibility gate already does.
//
// Pipeline (mirrors epub-validation.ts's own container.xml -> OPF
// resolution, extended into manifest/spine/content extraction):
//   1. open the ZIP (JSZip, already a project dependency)
//   2. resolve META-INF/container.xml -> the OPF package document path
//   3. parse the OPF's <manifest> (id -> href/media-type) and <spine>
//      (reading order, by idref into the manifest)
//   4. keep only spine items that are actual XHTML/HTML content
//      documents (skips stylesheets, fonts, images, and the EPUB3 nav
//      document if it's ever listed in spine; skips linear="no" items)
//   5. read each content document in spine order, sanitize its <body>
//      down to a small allowed-tag reading subset (see
//      sanitizeBodyIntoChunks below), and measure its plain-text length
//   6. once every document has been read, take the leading chunks (by
//      reading order, never truncating a chunk mid-element) that sum to
//      ~10% of the book's total readable text, grouped back into
//      per-document "sections" for the reader UI's Previous/Next
//
// Deliberately regex/tokenizer-based, not a new XML/HTML parsing
// dependency -- this project has no DOMParser/xmldom/cheerio/
// sanitize-html today, and epub-validation.ts already establishes the
// precedent of lightweight, non-conformance-grade regex parsing for
// EPUB's own XML being an accepted tradeoff here. A real EPUB content
// document is well-formed XHTML (every tag closed or self-closing, no
// HTML5 implied-close-tag ambiguity), which is exactly what makes a
// small stack-based tokenizer tractable without a full parser.
export type EpubSampleSection = {
  // Sanitized, render-ready HTML -- only ALLOWED_TAGS, zero attributes
  // on any of them. Safe to dangerouslySetInnerHTML as-is.
  html: string;
};

export type EpubSampleUnavailableReason =
  | "invalid_zip"
  | "missing_container"
  | "missing_opf"
  | "missing_manifest"
  | "missing_spine"
  | "no_readable_content";

export type EpubSampleResult =
  | {
      available: true;
      sections: EpubSampleSection[];
      // The actual fraction of total readable text included, as a
      // whole-number percent -- reported rather than hardcoded 10,
      // since preserving element boundaries means the true cutoff is
      // "the first element that reaches or passes 10%," not exactly 10%.
      approximatePercent: number;
    }
  | {
      available: false;
      reason: EpubSampleUnavailableReason;
    };

const TARGET_FRACTION = 0.1;

// Defensive bounds -- not a full abuse-prevention subsystem (the
// manuscript itself is already capped at 50MB by upload-time validation,
// see MAX_MANUSCRIPT_BYTES in dashboard/books/actions.ts), just backstops
// against a degenerate manifest/spine or a single pathological content
// document, so this function's own work stays bounded regardless of what
// upload-time validation did or didn't catch for older manuscripts.
const MAX_SPINE_ITEMS = 1000;
const MAX_DOCUMENT_CHARS = 2_000_000;

const ALLOWED_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
  "em", "strong", "i", "b", "br", "hr", "ul", "ol", "li", "small", "sup", "sub",
]);
const VOID_TAGS = new Set(["br", "hr"]);

// Tags whose entire subtree -- including their text content -- must
// never reach the output. This is the actual security boundary: script
// content, event-handler-bearing interactive elements, embedded
// documents/media, and anything that could carry a src/href (images are
// deliberately omitted for V1 too, per the PRODUCT-1 brief, rather than
// take on securely proxying/rewriting embedded asset URLs).
const DROP_ENTIRELY_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "option", "video", "audio", "canvas", "svg",
  "template", "noscript", "img", "picture", "source", "link", "meta", "base",
  "head", "title",
]);
// Everything else (div, span, a, section, article, nav, header, footer,
// aside, figure, table, ...) is UNWRAPPED: the tag itself is discarded
// (and with it, every attribute it carried -- including href/src/style/
// any on* handler) but its already-processed children are kept. This
// keeps the classification total and safe by construction: a tag name
// only ever reaches the output if it is literally in ALLOWED_TAGS,
// always with zero attributes, never because it merely wasn't matched by
// the deny list.

// A tag/text tokenizer for the well-formed-XML subset EPUB content
// documents are required to be. Matches, in order: comments, CDATA
// sections, processing instructions/DOCTYPE (all discarded), closing
// tags, and opening/self-closing tags (attributes are captured only to
// be discarded -- never inspected for anything, since none of
// ALLOWED_TAGS ever keeps any).
//
// LIBRUM 2.0 PRODUCT-1 PRE-COMMIT HARDENING: the comment alternative
// matches through to end-of-string as a fallback (`-->|$`) so an
// unterminated `<!--` consumes the REST of the document as an inert
// comment, rather than failing to match at all and leaking the literal
// "<!--" characters (and everything up to the next real tag) through as
// plain text. This is a content-fidelity fix, not a security one --
// even before it, any genuinely dangerous tag inside a broken comment's
// "body" was still independently matched and dropped by the ordinary
// tag alternatives below (a failed comment match consumes nothing, so
// it can never hide/swallow a real <script> the way a correctly-matched
// comment legitimately would).
//
// Known limitation, same class as epub-validation.ts's own regex-based
// rootfile match: a literal `>` inside a quoted attribute value (legal
// but exceedingly rare XHTML) can desynchronize tag-boundary detection
// for that one tag -- this is a lightweight structural tokenizer, not a
// conformance-grade XML parser. Traced through explicitly (PRE-COMMIT
// review): because attributes are ALWAYS discarded regardless of tag
// classification (see the destructuring below, which never reads the
// attrs capture group), a desynchronized tag boundary can only ever
// corrupt which literal TEXT ends up in which frame -- it can never
// cause an attribute value, or a tag name that isn't an exact
// case-insensitive match to a real HTML tag, to be emitted as active
// markup. See epub-sample.test.ts's "hostile markup" suite for the
// cases this reasoning was checked against.
const TOKEN_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;

type StackFrame = {
  tag: string;
  allowed: boolean;
  isDropped: boolean;
  // A closed child's rendered HTML/plain-text is appended to its
  // parent's these two arrays -- so a DROP_ENTIRELY_TAGS subtree that's
  // still open when the document ends (unbalanced/malformed markup)
  // never propagates anywhere, and every completed top-level (root's
  // direct child) element becomes exactly one chunk.
  html: string[];
  text: string[];
};

function makeFrame(tag: string, allowed: boolean, isDropped: boolean): StackFrame {
  return { tag, allowed, isDropped, html: [], text: [] };
}

// Splits one content document's <body> inner HTML into safe, complete,
// individually well-formed top-level chunks (paragraphs, headings, list
// blocks, etc.) -- never a chunk that stops mid-element. Each chunk
// pairs its sanitized HTML with its own plain-text content, which is
// what the 10% accumulation in extractEpubSample measures the length of.
function sanitizeBodyIntoChunks(bodyHtml: string): { html: string; text: string }[] {
  const root = makeFrame("#root", false, false);
  const stack: StackFrame[] = [root];
  const chunks: { html: string; text: string }[] = [];

  function isInsideDrop(): boolean {
    return stack.some((f) => f.isDropped);
  }

  // Root-level content only ever needs flushing as its own chunk when
  // it's genuine stray text directly in <body> (not wrapped in any
  // block element) -- flushed just before the next top-level element's
  // chunk (preserving reading order) and once more at the very end for
  // any trailing stray text.
  function flushRootPending() {
    if (root.html.length === 0) return;
    const text = root.text.join("").trim();
    if (text) chunks.push({ html: root.html.join(""), text });
    root.html = [];
    root.text = [];
  }

  // Text runs come straight from a token stream over valid (well-formed)
  // XHTML, where any literal &, <, > a real author's prose contains is
  // already XML-entity-escaped by the source document itself (&amp;,
  // &lt;, &gt;) -- that's what makes it valid XML in the first place.
  // Passed through verbatim here, not re-escaped: these substrings are
  // already correct, safe HTML text content, and escaping them again
  // would corrupt already-escaped entities (&amp; -> &amp;amp;, which
  // would then visibly render as the literal text "&amp;" instead of
  // "&"). A raw, unescaped `<` in text can't reach here at all -- the
  // tokenizer itself would have matched it as the start of a tag, not
  // text -- so this never becomes an HTML-injection vector.
  function appendText(raw: string) {
    if (!raw || isInsideDrop()) return;
    const frame = stack[stack.length - 1];
    frame.html.push(raw);
    frame.text.push(raw);
  }

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const capped = bodyHtml.length > MAX_DOCUMENT_CHARS ? bodyHtml.slice(0, MAX_DOCUMENT_CHARS) : bodyHtml;
  TOKEN_RE.lastIndex = 0;
  while ((match = TOKEN_RE.exec(capped))) {
    appendText(capped.slice(lastIndex, match.index));
    lastIndex = TOKEN_RE.lastIndex;

    const [, closeName, openName, , selfCloseMark] = match;

    if (closeName) {
      const name = closeName.toLowerCase();
      // Pop until (and including) the matching open frame, if any is
      // still on the stack -- tolerates a stray/mismatched close tag in
      // a malformed document without corrupting the whole parse.
      const idx = stack.map((f) => f.tag).lastIndexOf(name);
      if (idx === -1) continue;

      while (stack.length > idx) {
        const finished = stack.pop()!;
        const parent = stack[stack.length - 1];
        if (finished.isDropped) continue;

        const innerHtml = finished.html.join("");
        const innerText = finished.text.join("");
        const rendered = finished.allowed
          ? `<${finished.tag}>${innerHtml}</${finished.tag}>`
          : innerHtml;

        if (parent === root) {
          flushRootPending();
          const text = innerText.trim();
          if (text) chunks.push({ html: rendered, text: innerText });
        } else {
          parent.html.push(rendered);
          parent.text.push(innerText);
        }
      }
      continue;
    }

    if (openName) {
      const name = openName.toLowerCase();
      const selfClosing = selfCloseMark === "/" || VOID_TAGS.has(name);

      // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT HARDENING: a namespace-prefixed
      // dangerous tag (<svg:script>, <html:script>, ...) must be caught
      // by its LOCAL name too, not just an exact match on the full
      // "prefix:local" string -- otherwise it would fall through to the
      // default "unwrap" classification below and leak its inert text
      // content into the sample (never as an executable element -- see
      // this tokenizer's own top comment for why an unwrap can never
      // itself become active markup -- but still real content-leak
      // through a name DROP_ENTIRELY_TAGS was clearly meant to catch).
      // ALLOWED_TAGS is deliberately NOT given the same treatment: a
      // namespace-prefixed tag is never treated as one of the plain
      // reading tags, only an exact, unprefixed "p"/"strong"/etc. is.
      const localName = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;

      if (isInsideDrop() || DROP_ENTIRELY_TAGS.has(name) || DROP_ENTIRELY_TAGS.has(localName)) {
        if (!selfClosing) stack.push(makeFrame(name, false, true));
        continue;
      }

      if (VOID_TAGS.has(name)) {
        // <br>/<hr> never carry content -- emit immediately into the
        // current frame rather than pushing a stack entry for them.
        stack[stack.length - 1].html.push(`<${name}>`);
        continue;
      }

      if (selfClosing) {
        // A self-closing, non-void tag that isn't dropped either (e.g.
        // an unwrapped <div/>) -- contributes nothing, no frame needed.
        continue;
      }

      stack.push(makeFrame(name, ALLOWED_TAGS.has(name), false));
      continue;
    }

    // Comment/CDATA/PI/DOCTYPE -- the matched range itself is simply
    // never passed to appendText; nothing else to do for it.
  }

  // Trailing text after the last tag (rare for a real content document,
  // but handled so no readable text is silently dropped), then any
  // still-pending root-level stray text.
  appendText(capped.slice(lastIndex));
  flushRootPending();

  // LIBRUM 2.0 PRODUCT-1: a document with unbalanced/unclosed tags at
  // the end (malformed EPUB) -- every non-root frame still on the stack
  // here represents content that never cleanly closed. Rather than
  // guess at recovery, that trailing partial content is simply never
  // flushed as a chunk; whatever DID close cleanly above is still
  // returned. A whole-document failure only happens if that leaves zero
  // chunks, which the caller already treats as "this document
  // contributed nothing."
  return chunks;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type ManifestItem = { href: string; mediaType: string; isNav: boolean };

function parseManifest(opfXml: string): Map<string, ManifestItem> {
  const manifestMatch = opfXml.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i);
  const items = new Map<string, ManifestItem>();
  if (!manifestMatch) return items;

  const itemRe = /<item\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(manifestMatch[1]))) {
    const attrs = m[1];
    const id = attrs.match(/\bid\s*=\s*(["'])(.*?)\1/i)?.[2];
    const href = attrs.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const mediaType = attrs.match(/\bmedia-type\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "";
    const properties = attrs.match(/\bproperties\s*=\s*(["'])(.*?)\1/i)?.[2] ?? "";
    if (!id || !href) continue;
    items.set(id, {
      href,
      mediaType: mediaType.toLowerCase(),
      isNav: /\bnav\b/.test(properties),
    });
    if (items.size > MAX_SPINE_ITEMS * 4) break;
  }
  return items;
}

function parseSpineIdrefs(opfXml: string): string[] {
  const spineMatch = opfXml.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i);
  if (!spineMatch) return [];

  const idrefs: string[] = [];
  const itemrefRe = /<itemref\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = itemrefRe.exec(spineMatch[1]))) {
    const attrs = m[1];
    const idref = attrs.match(/\bidref\s*=\s*(["'])(.*?)\1/i)?.[2];
    const linear = attrs.match(/\blinear\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!idref) continue;
    if (linear && linear.toLowerCase() === "no") continue;
    idrefs.push(idref);
    if (idrefs.length >= MAX_SPINE_ITEMS) break;
  }
  return idrefs;
}

const CONTENT_MEDIA_TYPES = new Set(["application/xhtml+xml", "text/html"]);

export async function extractEpubSample(bytes: Buffer): Promise<EpubSampleResult> {
  // LIBRUM 2.0 EPUB-VALIDATION-1B: this is the CRITICAL call site --
  // /api/books/[id]/sample is public and unauthenticated, so this
  // function's own decompression calls below run on every request for
  // every published book, not just once at upload. Preflight runs
  // FIRST, against the raw buffer, before JSZip.loadAsync() -- and
  // therefore before any entry.async() call below (the OPF, or any
  // spine content document) -- using the SAME limits
  // validateEpubStructure() already enforces at ingestion
  // (EPUB_ZIP_PREFLIGHT_LIMITS, epub-validation.ts). A manuscript that
  // already passed that ingestion check will always pass this same
  // preflight again here too; this is a second, independent
  // enforcement of the same bound at the one other place raw archive
  // bytes are decompressed, not a new or different one. On failure,
  // this returns the existing safe "invalid_zip" unavailable result --
  // never a raw ZIP-parser error, never a 500.
  const preflight = preflightZipEntries(bytes, EPUB_ZIP_PREFLIGHT_LIMITS);
  if (!preflight.ok) {
    return { available: false, reason: "invalid_zip" };
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { available: false, reason: "invalid_zip" };
  }

  const containerFile = zip.file("META-INF/container.xml");
  if (!containerFile) return { available: false, reason: "missing_container" };

  let containerXml: string;
  try {
    // Safe to decompress fully -- bounded by the preflight above,
    // same as every other entry in this archive.
    containerXml = await containerFile.async("string");
  } catch {
    return { available: false, reason: "missing_container" };
  }

  const rootfileMatch = containerXml.match(
    /<rootfile\b[^>]*\bfull-path\s*=\s*(["'])(.*?)\1/i,
  );
  if (!rootfileMatch) return { available: false, reason: "missing_container" };

  // Leading-slash stripped first, exactly matching
  // epub-validation.ts's own approved compatibility tolerance for this
  // one field, before the shared resolver (which rejects a leading
  // slash outright for every OTHER path) ever sees it -- see
  // epub-archive-paths.ts's own comment for why the two behave
  // differently on purpose.
  const opfPathRaw = rootfileMatch[2].trim().replace(/^\/+/, "");
  const resolvedOpfPath = opfPathRaw ? resolveArchivePath("", opfPathRaw) : ({ safe: false } as const);
  if (!resolvedOpfPath.safe) return { available: false, reason: "missing_opf" };

  const opfFile = zip.file(resolvedOpfPath.path);
  if (!opfFile) return { available: false, reason: "missing_opf" };
  const opfPath = resolvedOpfPath.path;

  let opfXml: string;
  try {
    // Safe to decompress fully -- bounded by the preflight above.
    opfXml = await opfFile.async("string");
  } catch {
    return { available: false, reason: "missing_opf" };
  }

  const manifest = parseManifest(opfXml);
  if (manifest.size === 0) return { available: false, reason: "missing_manifest" };

  const spineIdrefs = parseSpineIdrefs(opfXml);
  if (spineIdrefs.length === 0) return { available: false, reason: "missing_spine" };

  const opfDir = posix.dirname(opfPath);

  // docChunks[i] holds every chunk belonging to spine document i, in
  // that document's own internal order -- read once, in full spine
  // order, before any 10%-cutoff decision is made (the cutoff needs the
  // TOTAL readable length across the whole book first).
  const docChunks: { html: string; text: string }[][] = [];
  // A spine that references the same manifest item (or, equivalently,
  // the same resolved path) more than once must only ever contribute
  // its content once -- otherwise a repeated <itemref> would both
  // double-count toward the 10% length target and duplicate that
  // document's text in the returned sections.
  const seenPaths = new Set<string>();

  for (const idref of spineIdrefs) {
    const item = manifest.get(idref);
    if (!item) continue;
    if (item.isNav) continue;
    if (item.mediaType && !CONTENT_MEDIA_TYPES.has(item.mediaType)) continue;

    // LIBRUM 2.0 EPUB-VALIDATION-1B: routed through the shared
    // resolver (epub-archive-paths.ts) -- an unsafe manifest href
    // (absolute, NUL-containing, or escaping above archive root) is
    // simply skipped, same as a not-found file already was before this
    // change; a malformed/hostile href never aborts the whole sample,
    // it just means that one spine item contributes nothing.
    const resolvedHref = resolveArchivePath(opfDir, item.href);
    if (!resolvedHref.safe) continue;
    const resolvedPath = resolvedHref.path;
    if (seenPaths.has(resolvedPath)) continue;
    seenPaths.add(resolvedPath);

    const docFile = zip.file(resolvedPath);
    if (!docFile) continue;

    let docXml: string;
    try {
      // Safe to decompress fully -- bounded by the preflight above,
      // same as every other entry in this archive.
      docXml = await docFile.async("string");
    } catch {
      continue;
    }

    const bodyMatch = docXml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    const bodyHtml = bodyMatch ? bodyMatch[1] : docXml;

    const chunks = sanitizeBodyIntoChunks(bodyHtml);
    if (chunks.length > 0) docChunks.push(chunks);
  }

  const totalLength = docChunks.reduce(
    (sum, chunks) => sum + chunks.reduce((s, c) => s + c.text.length, 0),
    0,
  );
  if (totalLength === 0) return { available: false, reason: "no_readable_content" };

  const target = Math.max(1, Math.ceil(totalLength * TARGET_FRACTION));

  const sections: EpubSampleSection[] = [];
  let included = 0;
  outer: for (const chunks of docChunks) {
    const sectionHtml: string[] = [];
    for (const chunk of chunks) {
      sectionHtml.push(chunk.html);
      included += chunk.text.length;
      if (included >= target) {
        sections.push({ html: sectionHtml.join("") });
        break outer;
      }
    }
    sections.push({ html: sectionHtml.join("") });
  }

  const approximatePercent = Math.min(100, Math.round((included / totalLength) * 100));

  return { available: true, sections, approximatePercent };
}

// Exported for tests only -- lets the sanitizer/tokenizer be exercised
// directly against hand-written XHTML fragments without needing a full
// ZIP fixture for every case.
export const __internal = { sanitizeBodyIntoChunks, normalizeWhitespace };
