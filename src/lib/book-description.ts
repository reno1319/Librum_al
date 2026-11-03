// BD15 P2: the book description as a small rich text, stored as text.
//
// The editor offers bold, italic, a bullet list and a numbered list
// (PLAN-BD15-r1 §2.3). No HTML is ever stored: the description column
// holds this small, fixed Markdown-like format, and every reader of it
// (the editor, and the book page in P8) parses it with parseDescription
// below, never with a general Markdown or HTML renderer. So a link, an
// image, a heading or a script can never come out of a description:
// the format has no syntax for them, and anything else is plain text.
//
// The format:
//   - Blocks are separated by a blank line.
//   - A line starting with "- " is a bullet item; a line starting with
//     a number, a full stop and a space ("1. ") is a numbered item.
//     Consecutive items of one kind are one list.
//   - Any other line is text. Consecutive text lines are one paragraph;
//     a single line break inside a paragraph stays a line break.
//   - Inside a line, "**" turns bold on or off and "*" turns italic on
//     or off. Formatting still open at the end of a line ends there.
//   - A backslash makes the next "*" or "\" plain text. A text line
//     that would otherwise read as a list item starts with "\-" or with
//     its number and "\.".
//
// normalizeDescription() is what the server stores: parse, then write
// back out, so the stored text is always in this one canonical form
// (whatever the browser sent) and the plain-text length is checked.

export const DESCRIPTION_MAX_CHARACTERS = 4000;

export const DESCRIPTION_TOO_LONG_MESSAGE = `Përshkrimi mund të ketë deri në ${groupThousands(DESCRIPTION_MAX_CHARACTERS)} karaktere.`;

export type DescriptionRun = { text: string; bold: boolean; italic: boolean };
export type DescriptionLine = DescriptionRun[];
export type DescriptionBlock =
  | { kind: "paragraph"; lines: DescriptionLine[] }
  | { kind: "bullets"; items: DescriptionLine[] }
  | { kind: "numbers"; items: DescriptionLine[] };

function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const BULLET_LINE = /^- /;
const NUMBER_LINE = /^\d{1,9}\. /;
const ESCAPED_BULLET_LINE = /^\\-/;
const ESCAPED_NUMBER_LINE = /^(\d{1,9})\\\./;

// Line breaks become "\n"; tabs become spaces; every other control
// character (and the Unicode line/paragraph separators) is dropped.
export function cleanDescriptionText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");
}

export function parseInline(source: string): DescriptionLine {
  const runs: DescriptionRun[] = [];
  let bold = false;
  let italic = false;
  let text = "";
  const flush = () => {
    if (text !== "") runs.push({ text, bold, italic });
    text = "";
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\\" && (source[i + 1] === "*" || source[i + 1] === "\\")) {
      text += source[i + 1];
      i++;
      continue;
    }
    if (ch === "*") {
      flush();
      if (source[i + 1] === "*") {
        bold = !bold;
        i++;
      } else {
        italic = !italic;
      }
      continue;
    }
    text += ch;
  }
  flush();
  return mergeRuns(runs);
}

function mergeRuns(runs: DescriptionRun[]): DescriptionRun[] {
  const merged: DescriptionRun[] = [];
  for (const run of runs) {
    if (run.text === "") continue;
    const last = merged[merged.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic) {
      last.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }
  return merged;
}

function lineIsBlank(line: DescriptionLine): boolean {
  return line.every((run) => run.text.trim() === "");
}

function trimLine(line: DescriptionLine): DescriptionLine {
  const runs = line.map((run) => ({ ...run }));
  while (runs.length > 0) {
    runs[0].text = runs[0].text.replace(/^ +/, "");
    if (runs[0].text === "") runs.shift();
    else break;
  }
  while (runs.length > 0) {
    const last = runs[runs.length - 1];
    last.text = last.text.replace(/ +$/, "");
    if (last.text === "") runs.pop();
    else break;
  }
  return mergeRuns(runs);
}

export function parseDescription(raw: string): DescriptionBlock[] {
  const blocks: DescriptionBlock[] = [];
  let current: DescriptionBlock | null = null;
  for (const rawLine of cleanDescriptionText(raw).split("\n")) {
    const line = rawLine.replace(/^ +/, "");
    if (line.trim() === "") {
      current = null;
      continue;
    }
    let kind: DescriptionBlock["kind"];
    let body: string;
    if (BULLET_LINE.test(line)) {
      kind = "bullets";
      body = line.slice(2);
    } else if (NUMBER_LINE.test(line)) {
      kind = "numbers";
      body = line.replace(NUMBER_LINE, "");
    } else {
      kind = "paragraph";
      body = line.replace(ESCAPED_BULLET_LINE, "-").replace(ESCAPED_NUMBER_LINE, "$1.");
    }
    const parsed = trimLine(parseInline(body));
    if (lineIsBlank(parsed)) {
      continue;
    }
    let block: DescriptionBlock;
    if (current && current.kind === kind) {
      block = current;
    } else {
      block = kind === "paragraph" ? { kind, lines: [] } : { kind, items: [] };
      blocks.push(block);
      current = block;
    }
    if (block.kind === "paragraph") block.lines.push(parsed);
    else block.items.push(parsed);
  }
  return blocks;
}

function escapeText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\*/g, "\\*");
}

// Markers are written only where bold or italic actually changes, and
// everything still open is closed at the end of the line. Within one
// change there is at most one "**" and one "*", and the reader toggles
// both whichever way "***" is split, so every line reads back exactly
// (audit r1, F1).
function serializeLine(line: DescriptionLine): string {
  let out = "";
  let bold = false;
  let italic = false;
  for (const run of mergeRuns(line)) {
    if (run.bold !== bold) {
      out += "**";
      bold = run.bold;
    }
    if (run.italic !== italic) {
      out += "*";
      italic = run.italic;
    }
    out += escapeText(run.text);
  }
  if (bold) out += "**";
  if (italic) out += "*";
  return out;
}

function serializeParagraphLine(line: DescriptionLine): string {
  const text = serializeLine(line);
  if (text.startsWith("-")) {
    // Only "- " opens a bullet, but any leading "-" is written "\-", so
    // the canonical form never depends on what follows the dash.
    return `\\${text}`;
  }
  const numbered = /^(\d{1,9})\./.exec(text);
  if (numbered) return `${numbered[1]}\\.${text.slice(numbered[0].length)}`;
  return text;
}

export function serializeDescription(blocks: readonly DescriptionBlock[]): string {
  return blocks
    .map((block) => {
      if (block.kind === "paragraph") return block.lines.map(serializeParagraphLine).join("\n");
      if (block.kind === "bullets") return block.items.map((item) => `- ${serializeLine(item)}`).join("\n");
      return block.items.map((item, index) => `${index + 1}. ${serializeLine(item)}`).join("\n");
    })
    .filter((text) => text !== "")
    .join("\n\n");
}

export function descriptionBlocksPlainText(blocks: readonly DescriptionBlock[]): string {
  const lineText = (line: DescriptionLine) => line.map((run) => run.text).join("");
  return blocks
    .map((block) => {
      if (block.kind === "paragraph") return block.lines.map(lineText).join("\n");
      if (block.kind === "bullets") return block.items.map((item) => `• ${lineText(item)}`).join("\n");
      return block.items.map((item, index) => `${index + 1}. ${lineText(item)}`).join("\n");
    })
    .join("\n\n");
}

// The description as plain text (meta tags, the EPUB, length checks).
export function descriptionPlainText(stored: string): string {
  return descriptionBlocksPlainText(parseDescription(stored));
}

// The visible characters an author has typed, as the counter shows them:
// the plain text without list markers and line breaks.
export function descriptionCharacterCount(blocks: readonly DescriptionBlock[]): number {
  let count = 0;
  for (const block of blocks) {
    const lines = block.kind === "paragraph" ? block.lines : block.items;
    for (const line of lines) for (const run of line) count += Array.from(run.text).length;
  }
  return count;
}

export type NormalizedDescription =
  | { ok: true; value: string }
  | { ok: false; message: string };

export function normalizeDescription(raw: unknown): NormalizedDescription {
  const blocks = parseDescription(typeof raw === "string" ? raw : "");
  if (descriptionCharacterCount(blocks) > DESCRIPTION_MAX_CHARACTERS) {
    return { ok: false, message: DESCRIPTION_TOO_LONG_MESSAGE };
  }
  return { ok: true, value: serializeDescription(blocks) };
}

// ------------------------------------------------------------------
// The editor's two directions. The editor is a contenteditable box: it
// is filled from the stored text with descriptionToEditorHtml (every
// character escaped; only <p>, <br>, <ul>, <ol>, <li>, <strong>, <em>
// are produced), and read back with descriptionFromEditorDom, which
// keeps only text, line and list structure, bold and italic. Whatever
// the browser or a paste put into the box, nothing else survives, and
// the server normalizes the result again.
// ------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function lineToHtml(line: DescriptionLine): string {
  return line
    .map((run) => {
      let html = escapeHtml(run.text);
      if (run.italic) html = `<em>${html}</em>`;
      if (run.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

export function descriptionToEditorHtml(stored: string): string {
  return parseDescription(stored)
    .map((block) => {
      if (block.kind === "paragraph") return `<p>${block.lines.map(lineToHtml).join("<br>")}</p>`;
      const tag = block.kind === "bullets" ? "ul" : "ol";
      return `<${tag}>${block.items.map((item) => `<li>${lineToHtml(item)}</li>`).join("")}</${tag}>`;
    })
    .join("");
}

// The few DOM members the reader needs, so it runs in the browser and
// in tests without a DOM library.
export type EditorNode = {
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<EditorNode>;
  getAttribute?: (name: string) => string | null;
};

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE", "SECTION", "ARTICLE", "HEADER", "FOOTER", "TABLE", "TR",
]);
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "OBJECT", "SVG", "IMG", "VIDEO", "AUDIO"]);

function styleOf(node: EditorNode, name: string): string {
  const style = node.getAttribute?.("style") ?? "";
  const match = new RegExp(`${name}\\s*:\\s*([^;]+)`, "i").exec(style);
  return match ? match[1].trim().toLowerCase() : "";
}

export function descriptionFromEditorDom(root: EditorNode): string {
  const blocks: DescriptionBlock[] = [];
  let lines: DescriptionLine[] = [];
  let line: DescriptionRun[] = [];

  const endLine = () => {
    lines.push(line);
    line = [];
  };
  const endParagraph = () => {
    if (line.length > 0) endLine();
    const kept = lines.map(trimLine).filter((l) => !lineIsBlank(l));
    if (kept.length > 0) blocks.push({ kind: "paragraph", lines: kept });
    lines = [];
  };

  const inline = (node: EditorNode, bold: boolean, italic: boolean, out: DescriptionRun[], breaks: () => void) => {
    if (node.nodeType === TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/[\n\r\t ]+/g, " ").replace(/ /g, " ");
      if (text !== "") out.push({ text, bold, italic });
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const tag = node.nodeName.toUpperCase();
    if (SKIPPED_TAGS.has(tag)) return;
    if (tag === "BR") {
      breaks();
      return;
    }
    const weight = styleOf(node, "font-weight");
    const nextBold = bold || tag === "B" || tag === "STRONG" || weight === "bold" || Number(weight) >= 600;
    const nextItalic = italic || tag === "I" || tag === "EM" || styleOf(node, "font-style") === "italic";
    for (const child of Array.from(node.childNodes)) inline(child, nextBold, nextItalic, out, breaks);
  };

  const list = (node: EditorNode, kind: "bullets" | "numbers", bold: boolean, italic: boolean) => {
    const items: DescriptionLine[] = [];
    for (const child of Array.from(node.childNodes)) {
      const tag = child.nodeType === ELEMENT_NODE ? child.nodeName.toUpperCase() : "";
      if (tag === "UL" || tag === "OL") {
        // A nested list is flattened into this one.
        const nested: DescriptionRun[] = [];
        const flushNested = () => {
          const t = trimLine(nested.splice(0));
          if (!lineIsBlank(t)) items.push(t);
        };
        for (const grand of Array.from(child.childNodes)) {
          inline(grand, bold, italic, nested, flushNested);
          flushNested();
        }
        continue;
      }
      const runs: DescriptionRun[] = [];
      const flush = () => {
        const t = trimLine(mergeRuns(runs.splice(0)));
        if (!lineIsBlank(t)) items.push(t);
      };
      inline(child, bold, italic, runs, flush);
      if (tag === "LI" || tag === "") flush();
    }
    if (items.length > 0) blocks.push({ kind, items });
  };

  const walk = (node: EditorNode, bold: boolean, italic: boolean) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === ELEMENT_NODE) {
        const tag = child.nodeName.toUpperCase();
        if (SKIPPED_TAGS.has(tag)) continue;
        if (tag === "UL" || tag === "OL") {
          endParagraph();
          list(child, tag === "UL" ? "bullets" : "numbers", bold, italic);
          continue;
        }
        if (BLOCK_TAGS.has(tag)) {
          endParagraph();
          const weight = styleOf(child, "font-weight");
          walk(
            child,
            bold || weight === "bold" || Number(weight) >= 600,
            italic || styleOf(child, "font-style") === "italic",
          );
          endParagraph();
          continue;
        }
        if (tag === "B" || tag === "STRONG" || tag === "I" || tag === "EM" || tag === "SPAN" || tag === "FONT" || tag === "U" || tag === "A") {
          // An inline element that may hold block children (a paste):
          // read it inline unless it contains a list or a block.
          const hasBlock = Array.from(child.childNodes).some(
            (c) => c.nodeType === ELEMENT_NODE && (BLOCK_TAGS.has(c.nodeName.toUpperCase()) || ["UL", "OL"].includes(c.nodeName.toUpperCase())),
          );
          if (hasBlock) {
            const nextBold = bold || tag === "B" || tag === "STRONG";
            const nextItalic = italic || tag === "I" || tag === "EM";
            walk(child, nextBold, nextItalic);
            continue;
          }
        }
      }
      inline(child, bold, italic, line, endLine);
    }
  };

  walk(root, false, false);
  endParagraph();

  return serializeDescription(
    blocks.map((block) =>
      block.kind === "paragraph"
        ? { kind: "paragraph", lines: block.lines.map(mergeRuns) }
        : { kind: block.kind, items: block.items.map(mergeRuns) },
    ),
  );
}
