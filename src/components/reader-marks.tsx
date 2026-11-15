"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { HIGHLIGHT_COLORS, HIGHLIGHT_COLOR_LABELS, MAX_NOTE_LENGTH, type HighlightColor } from "@/lib/reader-anchors";
import { parseMarksData, type MarkBookmark, type MarkHighlight, type MarksData, type MarksOp } from "@/lib/reader-marks";

// K8 + K10 (Renato 11-15, pictures r1 approved): the reader's bookmarks,
// highlights and synced place for a book the reader owns. This file is
// the network side (useReaderMarks) and the pieces drawn over the page:
// the marking bar, the note sheet, the three-tab panel and the short
// lines. The book page work (offsets, painting) is in book-reader.tsx
// with src/lib/reader-text-index.ts.

export type ReaderChrome = { bg: string; bar: string; text: string; muted: string; border: string };

// The swatches on the bar and in the list (the page itself uses the
// lighter rgba colours of reader-frame-doc.ts).
export const SWATCH: Record<HighlightColor, string> = {
  yellow: "#f6e27a",
  green: "#b9e3a8",
  blue: "#b4d4f5",
  pink: "#f5bcd0",
};

export type MarksState = { status: "off" | "loading" | "ready"; data: MarksData };
const EMPTY: MarksData = { place: null, bookmarks: [], highlights: [] };

export type MarksFailure = "limit" | "failed";

async function send(bookId: string, op: MarksOp, keepalive = false): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; why: MarksFailure }> {
  try {
    const res = await fetch(`/api/books/${bookId}/marks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(op),
      keepalive,
    });
    if (res.status === 409) return { ok: false, why: "limit" };
    if (!res.ok) return { ok: false, why: "failed" };
    return { ok: true, body: (await res.json()) as Record<string, unknown> };
  } catch {
    return { ok: false, why: "failed" };
  }
}

let tempCounter = 0;
const tempId = () => `tmp-${++tempCounter}`;
export const isTempId = (id: string) => id.startsWith("tmp-");

/**
 * Loads a book's marks once (bookId null = no marks: the free sample,
 * the author's own book). Every change shows at once and is undone if
 * the server refuses it (onFailure tells the reader why).
 */
export function useReaderMarks(bookId: string | null, onFailure: (why: MarksFailure) => void) {
  const [state, setState] = useState<MarksState>({ status: bookId ? "loading" : "off", data: EMPTY });
  const failRef = useRef(onFailure);
  useEffect(() => {
    failRef.current = onFailure;
  });

  useEffect(() => {
    if (!bookId) return;
    let live = true;
    fetch(`/api/books/${bookId}/marks`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        if (!live) return;
        const data = body === null ? null : parseMarksData(body);
        // 403 (not a buyer, e.g. the author) or a bad answer: no marks.
        setState(data ? { status: "ready", data } : { status: "off", data: EMPTY });
      })
      .catch(() => live && setState({ status: "off", data: EMPTY }));
    return () => {
      live = false;
    };
  }, [bookId]);

  const patch = useCallback((fn: (d: MarksData) => MarksData) => setState((s) => ({ ...s, data: fn(s.data) })), []);

  const addHighlight = useCallback(
    async (h: Omit<MarkHighlight, "id" | "orphaned">): Promise<string | null> => {
      if (!bookId) return null;
      const id = tempId();
      patch((d) => ({ ...d, highlights: [...d.highlights, { ...h, id, orphaned: false }].sort((a, b) => a.start - b.start) }));
      const r = await send(bookId, { op: "highlight_add", ...h });
      if (!r.ok || typeof r.body.id !== "string") {
        patch((d) => ({ ...d, highlights: d.highlights.filter((x) => x.id !== id) }));
        failRef.current(r.ok ? "failed" : r.why);
        return null;
      }
      const realId = r.body.id;
      patch((d) => ({ ...d, highlights: d.highlights.map((x) => (x.id === id ? { ...x, id: realId } : x)) }));
      return realId;
    },
    [bookId, patch],
  );

  const updateHighlight = useCallback(
    async (id: string, change: { color?: HighlightColor; note?: string | null }) => {
      if (!bookId || isTempId(id)) return;
      let before: MarkHighlight | undefined;
      patch((d) => ({
        ...d,
        highlights: d.highlights.map((x) => {
          if (x.id !== id) return x;
          before = x;
          return { ...x, ...change };
        }),
      }));
      const r = await send(bookId, { op: "highlight_update", id, ...change });
      if (!r.ok) {
        const old = before;
        if (old) patch((d) => ({ ...d, highlights: d.highlights.map((x) => (x.id === id ? old : x)) }));
        failRef.current(r.why);
      }
    },
    [bookId, patch],
  );

  const removeHighlight = useCallback(
    async (id: string) => {
      if (!bookId || isTempId(id)) return;
      let before: MarkHighlight | undefined;
      patch((d) => {
        before = d.highlights.find((x) => x.id === id);
        return { ...d, highlights: d.highlights.filter((x) => x.id !== id) };
      });
      const r = await send(bookId, { op: "highlight_remove", id });
      if (!r.ok) {
        const old = before;
        if (old) patch((d) => ({ ...d, highlights: [...d.highlights, old].sort((a, b) => a.start - b.start) }));
        failRef.current(r.why);
      }
    },
    [bookId, patch],
  );

  const addBookmark = useCallback(
    async (offset: number) => {
      if (!bookId) return;
      const id = tempId();
      patch((d) => ({ ...d, bookmarks: [...d.bookmarks, { id, offset }].sort((a, b) => a.offset - b.offset) }));
      const r = await send(bookId, { op: "bookmark_add", offset });
      if (!r.ok || typeof r.body.id !== "string") {
        patch((d) => ({ ...d, bookmarks: d.bookmarks.filter((x) => x.id !== id) }));
        failRef.current(r.ok ? "failed" : r.why);
        return;
      }
      const realId = r.body.id;
      // The same page saved twice (another tab): one row.
      patch((d) => ({
        ...d,
        bookmarks: d.bookmarks.filter((x) => x.id !== realId).map((x) => (x.id === id ? { ...x, id: realId } : x)),
      }));
    },
    [bookId, patch],
  );

  const removeBookmarks = useCallback(
    async (ids: string[]) => {
      const real = ids.filter((id) => !isTempId(id));
      if (!bookId || real.length === 0) return;
      let before: MarkBookmark[] = [];
      patch((d) => {
        before = d.bookmarks;
        return { ...d, bookmarks: d.bookmarks.filter((x) => !real.includes(x.id)) };
      });
      const r = await send(bookId, { op: "bookmark_remove", ids: real.slice(0, 50) });
      if (!r.ok) {
        const old = before;
        patch((d) => ({ ...d, bookmarks: old }));
        failRef.current(r.why);
      }
    },
    [bookId, patch],
  );

  /** Saves the place; the server's time of the save, or null. */
  const savePlace = useCallback(
    async (offset: number, progress: number, keepalive = false): Promise<string | null> => {
      if (!bookId) return null;
      const r = await send(bookId, { op: "place", offset, progress }, keepalive);
      return r.ok && typeof r.body.updatedAt === "string" ? r.body.updatedAt : null;
    },
    [bookId],
  );

  /** After a new version: where the found highlights are now, which were not found. */
  const reanchor = useCallback(
    async (moves: { id: string; start: number; end: number }[], orphaned: string[]) => {
      if (!bookId) return;
      const moved = new Map(moves.map((m) => [m.id, m]));
      const lost = new Set(orphaned);
      patch((d) => ({
        ...d,
        highlights: d.highlights
          .map((x) => {
            const m = moved.get(x.id);
            if (m) return { ...x, start: m.start, end: m.end, orphaned: false };
            if (lost.has(x.id)) return { ...x, orphaned: true };
            return x;
          })
          .sort((a, b) => a.start - b.start),
      }));
      // Not shown as a failure: it is tried again at the next open.
      await send(bookId, { op: "reanchor", moves, orphaned });
    },
    [bookId, patch],
  );

  return { state, addHighlight, updateHighlight, removeHighlight, addBookmark, removeBookmarks, savePlace, reanchor };
}

// ------------------------------------------------------------------
// The marking bar (Q1 a): 4 colours, Shënim, delete. No Copy (Q2 a).
// ------------------------------------------------------------------
export function SelectionBar({
  top,
  left,
  below,
  current,
  isNew,
  onColor,
  onNote,
  onDelete,
}: {
  top: number;
  left: number;
  below: boolean;
  current: HighlightColor | null;
  isNew: boolean;
  onColor: (c: HighlightColor) => void;
  onNote: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="absolute z-20 -translate-x-1/2" style={{ top, left }} data-reader-bar="">
      {below && <div className="mx-auto size-3 translate-y-1.5 rotate-45 bg-[#1f1d1a]" aria-hidden="true" />}
      <div className="flex items-center gap-0.5 rounded-full bg-[#1f1d1a] p-1.5 shadow-xl" role="toolbar" aria-label="Theksimi">
        {HIGHLIGHT_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`Theksoni me ngjyrë ${HIGHLIGHT_COLOR_LABELS[c].toLowerCase()}`}
            aria-pressed={current === c}
            onClick={() => onColor(c)}
            className="focus-ring flex size-11 items-center justify-center rounded-full"
          >
            <span
              className="size-7 rounded-full"
              style={{ background: SWATCH[c], boxShadow: current === c ? "0 0 0 2px #1f1d1a, 0 0 0 4px #fff" : undefined }}
            />
          </button>
        ))}
        <span className="mx-1 h-6 w-px bg-white/25" aria-hidden="true" />
        <button type="button" onClick={onNote} className="focus-ring min-h-11 rounded-full px-3 text-sm font-medium text-white">
          Shënim
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={isNew ? "Hiqni përzgjedhjen" : "Fshini theksimin"}
          className="focus-ring flex size-11 items-center justify-center rounded-full text-white"
        >
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
          </svg>
        </button>
      </div>
      {!below && <div className="mx-auto size-3 -translate-y-1.5 rotate-45 bg-[#1f1d1a]" aria-hidden="true" />}
    </div>
  );
}

// ------------------------------------------------------------------
// The note sheet: from the bottom on a phone, a box on a computer.
// ------------------------------------------------------------------
export function NoteSheet({
  chrome,
  quote,
  color,
  initial,
  onSave,
  onCancel,
}: {
  chrome: ReaderChrome;
  quote: string;
  color: HighlightColor;
  initial: string;
  onSave: (note: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="absolute inset-0 z-30 flex items-end justify-center bg-black/30 sm:items-center" onClick={onCancel}>
      <form
        role="dialog"
        aria-label="Shënimi juaj"
        className="w-full max-w-md rounded-t-2xl p-4 shadow-2xl sm:rounded-2xl"
        style={{ background: chrome.bar, color: chrome.text }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(value);
        }}
      >
        <label htmlFor="lb-note" className="text-xs font-semibold uppercase tracking-wide" style={{ color: chrome.muted }}>
          Shënimi juaj
        </label>
        <p className="mt-2 line-clamp-4 border-l-4 pl-3 font-serif text-[15px] leading-snug" style={{ borderColor: SWATCH[color] }}>
          «{quote}»
        </p>
        <textarea
          id="lb-note"
          autoFocus
          value={value}
          maxLength={MAX_NOTE_LENGTH}
          onChange={(e) => setValue(e.target.value)}
          rows={4}
          className="focus-ring mt-3 block w-full resize-none rounded-md border bg-transparent p-3 text-base"
          style={{ borderColor: chrome.border, color: chrome.text }}
        />
        <p className="mt-1 text-right text-xs tabular-nums" style={{ color: chrome.muted }}>
          {value.length} / {MAX_NOTE_LENGTH}
        </p>
        <div className="mt-2 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="focus-ring min-h-11 rounded-full px-4 text-sm">
            Anulo
          </button>
          <button type="submit" className="focus-ring min-h-11 rounded-full bg-[#1e3a32] px-5 text-sm font-semibold text-white">
            Ruaj
          </button>
        </div>
        <p className="mt-2 text-xs" style={{ color: chrome.muted }}>
          Shënimet i shihni vetëm ju.
        </p>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------
// The panel: Përmbajtja · Faqerojtësit · Theksimet (Q7 a).
// ------------------------------------------------------------------
export type PanelTab = "toc" | "bm" | "hl";
export type BookmarkRow = { id: string; page: number; chapter: string | null; onOpen: () => void };
export type HighlightRow = MarkHighlight & { page: number | null; chapter: string | null; onOpen: (() => void) | null };

export function MarksPanel({
  chrome,
  tab,
  setTab,
  contents,
  bookmarks,
  highlights,
  onRemoveBookmark,
  onRemoveHighlight,
}: {
  chrome: ReaderChrome;
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  contents: ReactNode;
  bookmarks: BookmarkRow[];
  highlights: HighlightRow[];
  onRemoveBookmark: (id: string) => void;
  onRemoveHighlight: (id: string) => void;
}) {
  const tabs: [PanelTab, string][] = [
    ["toc", "Përmbajtja"],
    ["bm", "Faqerojtësit"],
    ["hl", "Theksimet"],
  ];
  return (
    <div
      role="dialog"
      aria-label="Përmbajtja, faqerojtësit dhe theksimet"
      className="absolute right-2 top-full z-30 mt-1 w-[min(22rem,calc(100vw-1rem))] overflow-hidden rounded-lg border shadow-xl"
      style={{ background: chrome.bar, borderColor: chrome.border, color: chrome.text }}
    >
      <div role="tablist" className="flex border-b" style={{ borderColor: chrome.border }}>
        {tabs.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`lb-tab-${k}`}
            aria-selected={tab === k}
            aria-controls="lb-tabpanel"
            onClick={() => setTab(k)}
            className="focus-ring min-h-11 flex-1 px-1 text-[13px] font-semibold"
            style={{ color: tab === k ? chrome.text : chrome.muted, boxShadow: tab === k ? "inset 0 -2px 0 #c0841a" : undefined }}
          >
            {label}
          </button>
        ))}
      </div>
      <div id="lb-tabpanel" role="tabpanel" aria-labelledby={`lb-tab-${tab}`} className="max-h-[60vh] overflow-y-auto">
        {tab === "toc" && contents}
        {tab === "bm" &&
          (bookmarks.length === 0 ? (
            <p className="px-4 py-3 text-sm" style={{ color: chrome.muted }}>
              Nuk keni faqerojtës në këtë libër. Prekni shiritin lart për të shënuar faqen ku jeni.
            </p>
          ) : (
            <ul className="py-1">
              {bookmarks.map((b) => (
                <li key={b.id} className="flex items-center">
                  <button
                    type="button"
                    onClick={b.onOpen}
                    className="focus-ring flex min-h-12 flex-1 items-center gap-3 px-4 py-2 text-left text-sm hover:bg-black/5"
                  >
                    <svg viewBox="0 0 24 24" className="size-4 shrink-0" fill="#c0841a" aria-hidden="true">
                      <path d="M6 3.5h12v17l-6-4.2-6 4.2z" />
                    </svg>
                    <span className="min-w-0 flex-1">
                      <span className="block">Faqja {b.page}</span>
                      {b.chapter && (
                        <span className="block truncate text-xs" style={{ color: chrome.muted }}>
                          {b.chapter}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Hiqni faqerojtësin e faqes ${b.page}`}
                    onClick={() => onRemoveBookmark(b.id)}
                    className="focus-ring mr-1 flex size-11 items-center justify-center rounded-full text-lg hover:bg-black/5"
                    style={{ color: chrome.muted }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ))}
        {tab === "hl" &&
          (highlights.length === 0 ? (
            <p className="px-4 py-3 text-sm" style={{ color: chrome.muted }}>
              Nuk keni theksime në këtë libër. Mbani gishtin mbi një fjalë dhe tërhiqeni për të theksuar.
            </p>
          ) : (
            <ul>
              {highlights.map((h) => (
                <li key={h.id} className="border-b last:border-b-0" style={{ borderColor: chrome.border }}>
                  {h.orphaned ? (
                    <div className="px-4 py-3">
                      <HighlightRowBody h={h} chrome={chrome} />
                      <button
                        type="button"
                        onClick={() => onRemoveHighlight(h.id)}
                        className="focus-ring mt-1 min-h-11 rounded-full px-0 text-sm font-medium underline underline-offset-2"
                      >
                        Fshije
                      </button>
                    </div>
                  ) : (
                    <button type="button" onClick={h.onOpen ?? undefined} className="focus-ring block w-full px-4 py-3 text-left hover:bg-black/5">
                      <HighlightRowBody h={h} chrome={chrome} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ))}
      </div>
    </div>
  );
}

function HighlightRowBody({ h, chrome }: { h: HighlightRow; chrome: ReaderChrome }) {
  return (
    <>
      <span className="flex items-center gap-2 text-xs" style={{ color: chrome.muted }}>
        <span className="size-2.5 shrink-0 rounded-full" style={{ background: SWATCH[h.color] }} aria-hidden="true" />
        {h.orphaned ? (
          <span className="font-semibold text-[#9a5b00]">Ky tekst ndryshoi në versionin e ri</span>
        ) : (
          <span className="truncate">
            {h.page !== null ? `Faqja ${h.page}` : ""}
            {h.chapter ? ` · ${h.chapter}` : ""}
          </span>
        )}
      </span>
      <span className="mt-1.5 block font-serif text-[15px] leading-snug" style={{ opacity: h.orphaned ? 0.75 : 1 }}>
        <span style={{ boxShadow: `inset 0 -0.55em 0 ${SWATCH[h.color]}` }}>«{h.quote.length > 400 ? `${h.quote.slice(0, 400)}…` : h.quote}»</span>
      </span>
      {h.note && (
        <span className="mt-1.5 block whitespace-pre-line text-[13px] italic leading-snug" style={{ color: chrome.muted }}>
          Shënim: {h.note}
        </span>
      )}
    </>
  );
}

// ------------------------------------------------------------------
// Short lines over the page.
// ------------------------------------------------------------------
export function ReaderToast({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-3" role="status">
      <div className="pointer-events-auto flex min-h-11 max-w-md items-center gap-3 rounded-full bg-[#1f1d1a]/90 px-4 text-sm text-white shadow-lg">
        {children}
      </div>
    </div>
  );
}

export function ChangedVersionNotice({ count, onShow, onClose }: { count: number; onShow: () => void; onClose: () => void }) {
  return (
    <div className="absolute inset-x-0 top-3 z-20 flex justify-center px-3" role="status">
      <div className="flex min-h-11 max-w-md items-center gap-2 rounded-lg border bg-[#fff8e8] py-1 pl-4 pr-1 text-sm text-[#4a3b2a] shadow" style={{ borderColor: "#e3cf9f" }}>
        <span>
          {count === 1 ? "1 theksim nuk u gjet" : `${count} theksime nuk u gjetën`} në versionin e ri të librit.
        </span>
        <button type="button" onClick={onShow} className="focus-ring min-h-11 shrink-0 rounded px-1 font-semibold underline underline-offset-2">
          Shihini
        </button>
        <button type="button" onClick={onClose} aria-label="Mbyllni njoftimin" className="focus-ring flex size-11 shrink-0 items-center justify-center rounded text-lg leading-none">
          ×
        </button>
      </div>
    </div>
  );
}
