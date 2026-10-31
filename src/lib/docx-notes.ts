// W3 Part 2: Word footnotes and endnotes kept as notes in the ebook
// (Renato's answers 31 Oct: 8a numbers kept in book order; 1b
// footnotes at the end of their own chapter, endnotes in one "Shënime"
// chapter at the end of the book; 2a only with the clean-up pass on;
// 3a a note number on a chapter title stays on the title, never in the
// contents list).
//
// Mammoth writes each note reference as
//   <sup><a href="#footnote-20" id="footnote-ref-20">[1]</a></sup>
// and all note texts as one <ol> of <li id="footnote-20">…</li> at the
// very end of the whole document, each ending with a "↑" back link.
// That only works as one HTML page; the ebook is one page per chapter.
// So before the chapter split, every note text is taken out
// (extractNotes) and every reference becomes a private-use token that
// passes the sanitizer as plain text. After the split and sanitizing,
// renderNotes turns the tokens into Librum's own note links and writes
// the notes where they belong. Every attribute in that markup is built
// here from numbers only; note texts go through the same sanitizer as
// the chapters.

export const NOTE_TOKEN_OPEN = "\uE002";
export const NOTE_TOKEN_CLOSE = "\uE003";
const NOTE_PRIVATE_CHARS_RE = /[\uE002\uE003]/g;
// f = footnote, e = endnote; the number is Word's own note id (Word
// writes 32-bit ids, so 12 digits is plenty).
export const NOTE_TOKEN_RE = /\uE002([fe])(\d{1,12})\uE003/g;

export const ENDNOTES_HEADING = "Shënime";

export type NoteKind = "footnote" | "endnote";

export type ExtractedNotes = {
  html: string;
  // "f20" / "e3" -> the note's raw Mammoth HTML (back link removed).
  bodies: Map<string, string>;
};

const REF_RE = /<a href="#(footnote|endnote)-(\d{1,12})" id="\1-ref-\2">\[\d{1,12}\]<\/a>/g;
const ITEM_OPEN_RE = /<li id="(footnote|endnote)-(\d{1,12})">/g;
const BACK_LINK_RE = /\s?<a href="#(?:footnote|endnote)-ref-\d{1,12}">↑<\/a>/g;

function keyOf(kind: string, id: string): string {
  return `${kind === "footnote" ? "f" : "e"}${id}`;
}

// The end of the <li> opened at `from` (just after its open tag),
// counting nested lists inside a note. -1 if it never closes.
function closingLi(html: string, from: number): number {
  const re = /<li\b[^>]*>|<\/li>/g;
  re.lastIndex = from;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[0] === "</li>") {
      depth--;
      if (depth === 0) return m.index;
    } else depth++;
  }
  return -1;
}

export function extractNotes(rawHtml: string): ExtractedNotes {
  // The author's own text never carries the token characters.
  let html = rawHtml.replace(NOTE_PRIVATE_CHARS_RE, "");
  const bodies = new Map<string, string>();
  const cuts: [number, number][] = [];
  ITEM_OPEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITEM_OPEN_RE.exec(html))) {
    const start = m.index;
    const bodyStart = ITEM_OPEN_RE.lastIndex;
    const end = closingLi(html, bodyStart);
    if (end < 0) break;
    const body = html.slice(bodyStart, end).replace(BACK_LINK_RE, "");
    bodies.set(keyOf(m[1], m[2]), body);
    cuts.push([start, end + "</li>".length]);
    ITEM_OPEN_RE.lastIndex = end + "</li>".length;
  }
  for (let i = cuts.length - 1; i >= 0; i--) html = html.slice(0, cuts[i][0]) + html.slice(cuts[i][1]);
  html = html.replace(REF_RE, (_w, kind: string, id: string) => `${NOTE_TOKEN_OPEN}${keyOf(kind, id)}${NOTE_TOKEN_CLOSE}`);
  return { html, bodies };
}

// Takes the note tokens out of a chapter title (they stay out of the
// contents list) and returns them in order.
export function takeHeadingNotes(headingHtml: string): { html: string; keys: string[] } {
  const keys: string[] = [];
  const html = headingHtml.replace(NOTE_TOKEN_RE, (_w, k: string, id: string) => {
    keys.push(`${k}${id}`);
    return "";
  });
  return { html, keys };
}

export type NoteSection = {
  html: string;
  // Note keys on the chapter title, in order (answer 3a).
  headingKeys: string[];
};

export type RenderedNotes = {
  sections: { html: string; headingNotes?: string }[];
  // The "Shënime" chapter's body, or null when the book has no endnotes.
  endnotesHtml: string | null;
  footnotes: number;
  endnotes: number;
  // Note texts with no reference left in the book (dropped).
  unplaced: number;
};

// `sanitizeBody` cleans one note text exactly like chapter content.
// `chapterFile(i)` is the ebook file of chapter i; the "Shënime"
// chapter is the file after the last chapter.
export function renderNotes(
  sections: NoteSection[],
  bodies: Map<string, string>,
  sanitizeBody: (html: string) => string,
  chapterFile: (index: number) => string,
): RenderedNotes {
  const numbers = new Map<string, number>();
  const where = new Map<string, number>();
  let footnotes = 0;
  let endnotes = 0;
  const notesFile = chapterFile(sections.length);
  const assign = (key: string, chapter: number) => {
    if (numbers.has(key) || !bodies.has(key)) return;
    numbers.set(key, key[0] === "f" ? ++footnotes : ++endnotes);
    where.set(key, chapter);
  };
  sections.forEach((s, i) => {
    for (const key of s.headingKeys) assign(key, i);
    for (const m of s.html.matchAll(NOTE_TOKEN_RE)) assign(`${m[1]}${m[2]}`, i);
  });

  // Only the first reference to a note carries the id the note links
  // back to; a note referenced twice (audit F1) gets the same link again
  // without the id, so no id appears twice. Title references come first
  // (they are first in the chapter). Each chapter is its own file, so a
  // link names the note's file unless the note is in the same chapter:
  // a footnote sits at the end of the chapter of its first reference
  // (audit r2 F1b: a second reference in a later chapter), an endnote
  // always in the "Shënime" chapter.
  const withId = new Set<string>();
  const link = (key: string, chapter: number): string => {
    const n = numbers.get(key)!;
    const kind = key[0] === "f" ? "fn" : "en";
    const id = withId.has(key) ? "" : ` id="${kind}ref-${n}"`;
    withId.add(key);
    const file = kind === "fn" ? (where.get(key) === chapter ? "" : chapterFile(where.get(key)!)) : notesFile;
    return `<a epub:type="noteref" href="${file}#${kind}-${n}"${id}>${n}</a>`;
  };
  // Mammoth's <sup> (doubled in Apple Pages files) around a reference is
  // folded into one <sup> around Librum's link. A reference whose note
  // text is missing leaves nothing behind. A reference inside a web link
  // (audit F2) moves to just after that link: a link inside a link is
  // not allowed in an ebook.
  const PIECE_RE = /(<a\b[^>]*>)|(<\/a>)|((?:<sup>)*)\uE002([fe])(\d{1,12})\uE003((?:<\/sup>)*)/g;
  const replaceRefs = (html: string, chapter: number) => {
    let depth = 0;
    let moved = "";
    const out = html.replace(
      PIECE_RE,
      (w: string, open?: string, close?: string, opens = "", k = "", id = "", closes = "") => {
        if (open) {
          depth++;
          return w;
        }
        if (close) {
          if (depth > 0) depth--;
          if (depth > 0 || !moved) return w;
          const after = moved;
          moved = "";
          return w + after;
        }
        const key = `${k}${id}`;
        const o = opens.length / 5;
        const c = closes.length / 6;
        const m = Math.min(o, c);
        const left = "<sup>".repeat(o - m);
        const right = "</sup>".repeat(c - m);
        if (!numbers.has(key)) return left + right;
        const ref = `<sup>${link(key, chapter)}</sup>`;
        if (depth > 0) {
          moved += ref;
          return left + right;
        }
        return left + ref + right;
      },
    );
    return out + moved;
  };
  // The note number, linked back to its place in the text, opens the
  // note's first paragraph.
  const noteBody = (key: string, backHref: string): string => {
    const n = numbers.get(key)!;
    const back = `<a href="${backHref}">${n}</a>`;
    const body = sanitizeBody(bodies.get(key)!).trim().replace(/^<p>[ \t\r\n]+/, "<p>");
    if (body.startsWith("<p>")) return `<p>${back} ${body.slice(3)}`;
    return `<p>${back}</p>${body}`;
  };

  const out = sections.map((s, i) => {
    const headingNotes = s.headingKeys
      .filter((k) => numbers.has(k))
      .map((k) => `<sup>${link(k, i)}</sup>`)
      .join("");
    let html = replaceRefs(s.html, i);
    const own = [...numbers.keys()].filter((k) => k[0] === "f" && where.get(k) === i);
    if (own.length > 0) {
      html += own
        .map((k) => `\n<aside epub:type="footnote" id="fn-${numbers.get(k)}" class="footnote">${noteBody(k, `#fnref-${numbers.get(k)}`)}</aside>`)
        .join("");
    }
    return { html, ...(headingNotes ? { headingNotes } : {}) };
  });

  const endKeys = [...numbers.keys()].filter((k) => k[0] === "e");
  const endnotesHtml =
    endKeys.length > 0
      ? endKeys
          .map((k) => {
            const n = numbers.get(k)!;
            return `<div class="endnote" id="en-${n}">${noteBody(k, `${chapterFile(where.get(k)!)}#enref-${n}`)}</div>`;
          })
          .join("\n")
      : null;

  let unplaced = 0;
  for (const [key, body] of bodies) {
    if (!numbers.has(key) && sanitizeBody(body).replace(/<[^>]+>/g, "").trim().length > 0) unplaced++;
  }
  return { sections: out, endnotesHtml, footnotes, endnotes, unplaced };
}
