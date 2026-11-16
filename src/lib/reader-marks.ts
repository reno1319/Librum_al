// K8 + K10 (Renato 11-15): what the reader sends to and gets from the
// marks route (src/app/api/books/[id]/marks/route.ts). The route checks
// every write here before the database's own checks see it.

import {
  CONTEXT_LENGTH,
  MAX_HIGHLIGHTS_PER_BOOK,
  MAX_NOTE_LENGTH,
  MAX_QUOTE_LENGTH,
  isHighlightColor,
  type HighlightColor,
} from "@/lib/reader-anchors";

export type MarkHighlight = {
  id: string;
  start: number;
  end: number;
  quote: string;
  prefix: string;
  suffix: string;
  color: HighlightColor;
  note: string | null;
  // The words were not found in the book's current text (Q3 a).
  orphaned: boolean;
};
export type MarkBookmark = { id: string; offset: number };
export type MarkPlace = { offset: number; progress: number; updatedAt: string };
export type MarksData = { place: MarkPlace | null; bookmarks: MarkBookmark[]; highlights: MarkHighlight[] };

export type MarksOp =
  | { op: "place"; offset: number; progress: number }
  | { op: "bookmark_add"; offset: number }
  | { op: "bookmark_remove"; ids: string[] }
  | { op: "highlight_add"; start: number; end: number; quote: string; prefix: string; suffix: string; color: HighlightColor; note: string | null }
  | { op: "highlight_update"; id: string; color?: HighlightColor; note?: string | null }
  | { op: "highlight_remove"; id: string }
  // After a new version: where the found highlights are now, and which
  // were not found.
  | { op: "reanchor"; moves: { id: string; start: number; end: number }[]; orphaned: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OFFSET = 50_000_000;

const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const isOffset = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_OFFSET;
const isShortText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/** A note as saved: trimmed, null when empty; undefined when not valid. */
export function cleanNote(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (t === "") return null;
  return t.length <= MAX_NOTE_LENGTH ? t : undefined;
}

/** The request body as one operation, or null for anything else. */
export function parseMarksOp(body: unknown): MarksOp | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  switch (b.op) {
    case "place":
      if (!isOffset(b.offset) || typeof b.progress !== "number" || !(b.progress >= 0 && b.progress <= 1)) return null;
      return { op: "place", offset: b.offset, progress: Math.round(b.progress * 10000) / 10000 };
    case "bookmark_add":
      return isOffset(b.offset) ? { op: "bookmark_add", offset: b.offset } : null;
    case "bookmark_remove":
      if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > 50 || !b.ids.every(isId)) return null;
      return { op: "bookmark_remove", ids: b.ids };
    case "highlight_add": {
      if (!isOffset(b.start) || !isOffset(b.end) || b.end <= b.start) return null;
      if (typeof b.quote !== "string" || b.quote.length === 0 || b.quote.length > MAX_QUOTE_LENGTH) return null;
      if (b.quote.length !== b.end - b.start) return null;
      if (!isShortText(b.prefix, CONTEXT_LENGTH * 2) || !isShortText(b.suffix, CONTEXT_LENGTH * 2)) return null;
      if (!isHighlightColor(b.color)) return null;
      const note = b.note === undefined ? null : cleanNote(b.note);
      if (note === undefined) return null;
      return { op: "highlight_add", start: b.start, end: b.end, quote: b.quote, prefix: b.prefix, suffix: b.suffix, color: b.color, note };
    }
    case "highlight_update": {
      if (!isId(b.id)) return null;
      const out: { op: "highlight_update"; id: string; color?: HighlightColor; note?: string | null } = { op: "highlight_update", id: b.id };
      if (b.color !== undefined) {
        if (!isHighlightColor(b.color)) return null;
        out.color = b.color;
      }
      if (b.note !== undefined) {
        const note = cleanNote(b.note);
        if (note === undefined) return null;
        out.note = note;
      }
      return out.color === undefined && out.note === undefined ? null : out;
    }
    case "highlight_remove":
      return isId(b.id) ? { op: "highlight_remove", id: b.id } : null;
    case "reanchor": {
      if (!Array.isArray(b.moves) || !Array.isArray(b.orphaned)) return null;
      if (b.moves.length + b.orphaned.length === 0 || b.moves.length + b.orphaned.length > MAX_HIGHLIGHTS_PER_BOOK) return null;
      const moves: { id: string; start: number; end: number }[] = [];
      for (const m of b.moves as unknown[]) {
        if (typeof m !== "object" || m === null) return null;
        const r = m as Record<string, unknown>;
        if (!isId(r.id) || !isOffset(r.start) || !isOffset(r.end) || r.end <= r.start) return null;
        moves.push({ id: r.id, start: r.start, end: r.end });
      }
      if (!b.orphaned.every(isId)) return null;
      return { op: "reanchor", moves, orphaned: b.orphaned as string[] };
    }
    default:
      return null;
  }
}

type HighlightRow = {
  id: unknown;
  start_offset: unknown;
  end_offset: unknown;
  quote: unknown;
  prefix: unknown;
  suffix: unknown;
  color: unknown;
  note: unknown;
  orphaned_at: unknown;
};

/** Database rows as the reader's highlights; a malformed row is dropped. */
export function toMarkHighlights(rows: unknown): MarkHighlight[] {
  if (!Array.isArray(rows)) return [];
  const out: MarkHighlight[] = [];
  for (const raw of rows as HighlightRow[]) {
    if (!raw || !isId(raw.id) || !isOffset(raw.start_offset) || !isOffset(raw.end_offset) || typeof raw.quote !== "string") continue;
    if (!isHighlightColor(raw.color)) continue;
    out.push({
      id: raw.id,
      start: raw.start_offset,
      end: raw.end_offset,
      quote: raw.quote,
      prefix: typeof raw.prefix === "string" ? raw.prefix : "",
      suffix: typeof raw.suffix === "string" ? raw.suffix : "",
      color: raw.color,
      note: typeof raw.note === "string" ? raw.note : null,
      orphaned: raw.orphaned_at !== null && raw.orphaned_at !== undefined,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The read answer's checks, on the reader's side (a bad answer = no marks). */
export function parseMarksData(v: unknown): MarksData | null {
  if (typeof v !== "object" || v === null) return null;
  const d = v as Record<string, unknown>;
  if (!Array.isArray(d.bookmarks) || !Array.isArray(d.highlights)) return null;
  const p = d.place as Record<string, unknown> | null | undefined;
  const place =
    p && isOffset(p.offset) && typeof p.progress === "number" && typeof p.updatedAt === "string"
      ? { offset: p.offset, progress: p.progress, updatedAt: p.updatedAt }
      : null;
  const bookmarks = (d.bookmarks as unknown[]).flatMap((m) => {
    const r = m as Record<string, unknown> | null;
    return r && isId(r.id) && isOffset(r.offset) ? [{ id: r.id, offset: r.offset }] : [];
  });
  const highlights = (d.highlights as unknown[]).flatMap((h) => {
    const r = h as Record<string, unknown> | null;
    if (!r || !isId(r.id) || !isOffset(r.start) || !isOffset(r.end) || typeof r.quote !== "string" || !isHighlightColor(r.color)) return [];
    return [
      {
        id: r.id,
        start: r.start,
        end: r.end,
        quote: r.quote,
        prefix: typeof r.prefix === "string" ? r.prefix : "",
        suffix: typeof r.suffix === "string" ? r.suffix : "",
        color: r.color,
        note: typeof r.note === "string" ? r.note : null,
        orphaned: r.orphaned === true,
      },
    ];
  });
  return { place, bookmarks, highlights };
}
