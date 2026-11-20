// Blog editor buttons (Renato 2026-11-19, e1): what each button does to
// the Markdown text and the selection. Pure functions so they can be
// tested without a browser; the editor applies the result to its
// textarea.

export type FormatKind = "bold" | "italic" | "h2" | "h3" | "ul" | "ol" | "quote" | "link";

export type TextEdit = { text: string; selectionStart: number; selectionEnd: number };

function wrap(text: string, start: number, end: number, marker: string, placeholder: string): TextEdit {
  // Spaces at the edges of the selection stay outside the markers
  // ("**word **" would not be bold in Markdown).
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  while (start < end && /\s/.test(text[start])) start += 1;
  const selected = text.slice(start, end);
  const inner = selected || placeholder;
  const next = text.slice(0, start) + marker + inner + marker + text.slice(end);
  const s = start + marker.length;
  return { text: next, selectionStart: s, selectionEnd: s + inner.length };
}

// The whole lines the selection touches.
function lineRange(text: string, start: number, end: number): [number, number] {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  return [from, nl === -1 ? text.length : nl];
}

const LINE_PREFIX = /^(#{1,6} |> |- |\d+\. )/;

function prefixLines(text: string, start: number, end: number, prefix: (i: number) => string): TextEdit {
  const [from, to] = lineRange(text, start, end);
  const lines = text.slice(from, to).split("\n");
  const allHave = lines.every((l, i) => l.startsWith(prefix(i)));
  const out = lines.map((l, i) => (allHave ? l.slice(prefix(i).length) : prefix(i) + l.replace(LINE_PREFIX, "")));
  const block = out.join("\n");
  return { text: text.slice(0, from) + block + text.slice(to), selectionStart: from, selectionEnd: from + block.length };
}

export function applyFormat(text: string, start: number, end: number, kind: FormatKind): TextEdit {
  const s = Math.max(0, Math.min(start, end, text.length));
  const e = Math.min(text.length, Math.max(start, end));
  switch (kind) {
    case "bold":
      return wrap(text, s, e, "**", "tekst i theksuar");
    case "italic":
      return wrap(text, s, e, "*", "tekst i pjerrët");
    case "h2":
      return prefixLines(text, s, e, () => "## ");
    case "h3":
      return prefixLines(text, s, e, () => "### ");
    case "ul":
      return prefixLines(text, s, e, () => "- ");
    case "ol":
      return prefixLines(text, s, e, (i) => `${i + 1}. `);
    case "quote":
      return prefixLines(text, s, e, () => "> ");
    case "link": {
      const label = text.slice(s, e) || "teksti i lidhjes";
      const url = "https://";
      const next = `${text.slice(0, s)}[${label}](${url})${text.slice(e)}`;
      const urlStart = s + label.length + 3;
      return { text: next, selectionStart: urlStart, selectionEnd: urlStart + url.length };
    }
  }
}

function escapeAlt(value: string): string {
  return value.replace(/[\\[\]]/g, (c) => `\\${c}`);
}

function escapeTitle(value: string): string {
  return value.replace(/["\\]/g, (c) => `\\${c}`);
}

// An uploaded image as its own paragraph at the cursor. The caption is
// both the alt text and the Markdown title, which the article shows
// under the picture.
export function insertImage(text: string, at: number, url: string, caption: string): TextEdit {
  const pos = Math.max(0, Math.min(at, text.length));
  const clean = caption.replace(/\s+/g, " ").trim();
  const md = clean ? `![${escapeAlt(clean)}](${url} "${escapeTitle(clean)}")` : `![](${url})`;
  const before = text.slice(0, pos);
  const after = text.slice(pos);
  const lead = before === "" ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  const tail = after === "" ? "\n" : after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
  const next = before + lead + md + tail + after;
  const end = before.length + lead.length + md.length;
  return { text: next, selectionStart: end, selectionEnd: end };
}
