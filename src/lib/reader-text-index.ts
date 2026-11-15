// K8 + K10 (Renato 11-15): the reader's map from character offsets (see
// reader-anchors.ts) to the text nodes in its frame, and the painting of
// highlights as <mark> elements. The reader page does this from outside
// the script-less frame (the frame is same-origin, so its DOM can be
// read and changed; nothing runs inside it). Painting only wraps text in
// marks, so the text, and every offset, stays the same.

import { lastAtOrBefore } from "@/lib/reader-anchors";

export type TextIndex = { nodes: Text[]; starts: number[]; text: string; startOf: Map<Text, number> };

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT (no global NodeFilter needed)

// A paragraph-like element: between two of them the index counts one
// "\n" that is in no text node, so the words of two paragraphs never run
// together in a highlight's words (offsets stay exact: that character
// simply has no node; see locate()).
const BLOCK = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, pre, div, hr";

export function buildTextIndex(root: Element): TextIndex {
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  const nodes: Text[] = [];
  const starts: number[] = [];
  const startOf = new Map<Text, number>();
  const parts: string[] = [];
  let at = 0;
  let lastBlock: Element | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const len = t.data.length;
    if (len === 0) continue;
    const block = t.parentElement?.closest(BLOCK) ?? null;
    if (nodes.length > 0 && block !== lastBlock) {
      parts.push("\n");
      at += 1;
    }
    lastBlock = block;
    nodes.push(t);
    starts.push(at);
    startOf.set(t, at);
    parts.push(t.data);
    at += len;
  }
  return { nodes, starts, text: parts.join(""), startOf };
}

/** The text node holding `offset` and the offset inside it. */
export function locate(index: TextIndex, offset: number): { node: Text; inNode: number } | null {
  if (index.nodes.length === 0) return null;
  const clamped = Math.max(0, Math.min(offset, index.text.length));
  let i = lastAtOrBefore(index.starts, clamped);
  if (i < 0) i = 0;
  // An offset at a node's very end belongs to the next node, if any.
  const node = index.nodes[i];
  return { node, inNode: Math.min(clamped - index.starts[i], node.data.length) };
}

export function rangeFor(index: TextIndex, start: number, end: number): Range | null {
  const a = locate(index, start);
  const b = locate(index, end);
  if (!a || !b) return null;
  const range = a.node.ownerDocument.createRange();
  range.setStart(a.node, a.inNode);
  range.setEnd(b.node, b.inNode);
  return range;
}

/** A DOM position (from caretRangeFromPoint) as a book offset. */
export function offsetOfPosition(index: TextIndex, node: Node, inNode: number): number | null {
  if (node.nodeType === 3) {
    const s = index.startOf.get(node as Text);
    return s === undefined ? null : s + Math.min(inNode, (node as Text).data.length);
  }
  // An element position: the first text at or after that child.
  const child = node.childNodes[inNode] ?? null;
  const doc = node.ownerDocument;
  if (!doc) return null;
  const walker = doc.createTreeWalker(child ?? node, SHOW_TEXT);
  const first = walker.nextNode() as Text | null;
  if (first) {
    const s = index.startOf.get(first);
    if (s !== undefined) return s;
  }
  return null;
}

/** The book offset under a point of the frame's viewport, or null. */
export function offsetAtPoint(doc: Document, index: TextIndex, x: number, y: number): number | null {
  const d = doc as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof d.caretRangeFromPoint === "function") {
    const r = d.caretRangeFromPoint(x, y);
    return r ? offsetOfPosition(index, r.startContainer, r.startOffset) : null;
  }
  if (typeof d.caretPositionFromPoint === "function") {
    const p = d.caretPositionFromPoint(x, y);
    return p ? offsetOfPosition(index, p.offsetNode, p.offset) : null;
  }
  return null;
}

export const MARK_ATTR = "data-lb-hl";
const NO_INLINE_PARENT = new Set(["TABLE", "THEAD", "TBODY", "TFOOT", "TR", "UL", "OL"]);

/** Takes every painted highlight out again (the text is left as it was). */
export function unpaintHighlights(root: Element): void {
  const marks = Array.from(root.querySelectorAll(`mark[${MARK_ATTR}]`));
  const parents = new Set<Node>();
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parents.add(parent);
  }
  for (const p of parents) p.normalize();
}

/**
 * Paints each span as <mark data-lb-hl=id class="lb-hl lb-hl-<colour>">
 * around the text it covers (several marks when it crosses paragraphs).
 * Returns the new index (the text nodes were split).
 */
export function paintHighlights(root: Element, spans: { id: string; start: number; end: number; color: string }[]): TextIndex {
  unpaintHighlights(root);
  // From the end of the book backwards: splitting a text node never moves
  // the nodes before it, so one index serves every span, except where a
  // span overlaps the one painted just before (then it is rebuilt).
  const ordered = [...spans].sort((a, b) => b.start - a.start);
  let index = buildTextIndex(root);
  let paintedFrom = Infinity;
  for (const span of ordered) {
    if (span.end > paintedFrom) index = buildTextIndex(root);
    if (span.end <= span.start || span.start >= index.text.length) continue;
    paintedFrom = span.start;
    const first = lastAtOrBefore(index.starts, span.start);
    for (let i = Math.max(0, first); i < index.nodes.length && index.starts[i] < span.end; i++) {
      let node = index.nodes[i];
      const nodeStart = index.starts[i];
      const from = Math.max(span.start, nodeStart) - nodeStart;
      const to = Math.min(span.end, nodeStart + node.data.length) - nodeStart;
      if (to <= from) continue;
      if (from > 0) node = node.splitText(from);
      if (to - from < node.data.length) node.splitText(to - from);
      // Spaces between table rows or list items stay where they are (a
      // <mark> there would not be valid HTML).
      if (node.data.trim() === "" && NO_INLINE_PARENT.has(node.parentElement?.tagName ?? "")) continue;
      const mark = node.ownerDocument.createElement("mark");
      mark.setAttribute(MARK_ATTR, span.id);
      mark.className = `lb-hl lb-hl-${span.color}`;
      node.parentNode?.insertBefore(mark, node);
      mark.appendChild(node);
    }
  }
  return buildTextIndex(root);
}

/** The id of the innermost painted highlight holding a text position. */
export function highlightAtNode(node: Node | null): string | null {
  const el = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
  return el?.closest(`mark[${MARK_ATTR}]`)?.getAttribute(MARK_ATTR) ?? null;
}
