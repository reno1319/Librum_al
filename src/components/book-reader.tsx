"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { IconClose } from "@/components/icons";
import {
  READER_FONT_FACES,
  READER_FONT_STEPS,
  READER_FONTS,
  READER_FRAME_SANDBOX,
  READER_THEMES,
  buildReaderFrameDoc,
  type ReaderFont,
  type ReaderTheme,
} from "@/lib/reader-frame-doc";
import {
  anchorFor,
  firstOffsetWhere,
  parseLocalPlace,
  progressOf,
  reanchor as findAgain,
  serializeLocalPlace,
  serverPlaceWins,
  snapToWords,
  type HighlightColor,
  type LocalPlace,
} from "@/lib/reader-anchors";
import { RATE_PROMPT_LATER, RATE_PROMPT_TEXT, rateBarVisible, readRateDismissed, writeRateDismissed } from "@/lib/rate-prompt";
import { buildTextIndex, locate, offsetAtPoint, paintHighlights, rangeFor, type TextIndex } from "@/lib/reader-text-index";
import {
  ChangedVersionNotice,
  MarksPanel,
  NoteSheet,
  ReaderToast,
  SelectionBar,
  useReaderMarks,
  type BookmarkRow,
  type HighlightRow,
  type MarksFailure,
  type PanelTab,
} from "@/components/reader-marks";

// PREVIEW-READER-1: the page-turning reader (readers' sample and the
// author's whole-book preview). The book text lives in an iframe that is
// sandboxed with no permission to run scripts and carries its own CSP (see
// reader-frame-doc.ts); this component lays it out in CSS columns and
// turns pages from outside the frame. Taps, swipes and keys are caught
// by a clear layer over the frame (Safari does not deliver events into a
// script-less sandboxed frame), which also means the text can't be
// selected or copied from the sample.
//
// K8 + K10 (Renato 11-15): in a book the reader owns, the same clear
// layer also does Librum's own marking (Q1 a: press and hold, drag, let
// go; with a mouse, press and drag): the words under the finger are
// found with caretRangeFromPoint on the frame's document from outside,
// and highlights are painted as <mark> elements in the frame. Still no
// native selection, so still no Copy (Q2 a). Bookmarks, highlights and
// the place sync through /api/books/[id]/marks.

export type ReaderData = {
  title: string;
  author: string | null;
  mode: "sample" | "full" | "owned";
  html: string;
  toc: { id: string; label: string }[];
  approximatePercent: number;
};

export type ReaderEndAction = { label: string; onSelect: () => void } | null;
export type ReaderDevice = "phone" | "tablet" | "ereader";

const DEVICE_SIZE: Record<ReaderDevice, { w: number; h: number; label: string }> = {
  phone: { w: 390, h: 780, label: "Telefon" },
  tablet: { w: 820, h: 1100, label: "Tablet" },
  ereader: { w: 600, h: 800, label: "Lexues elektronik" },
};

// K9 r2: this page's origin never changes while it is open.
const subscribeNever = () => () => {};
const readOrigin = () => window.location.origin;
const readNoOrigin = () => null;

const SETTINGS_KEY = "librum-reader-settings";
type Settings = { theme: ReaderTheme; step: number; font: ReaderFont };
const DEFAULT_SETTINGS: Settings = { theme: "light", step: 2, font: "classic" };

export function readSettings(): Settings {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    const theme = raw?.theme && raw.theme in READER_THEMES ? raw.theme : DEFAULT_SETTINGS.theme;
    const step =
      typeof raw?.step === "number" && raw.step >= 0 && raw.step < READER_FONT_STEPS.length ? Math.floor(raw.step) : DEFAULT_SETTINGS.step;
    // K9: a missing or unknown font (older saved settings) reads as Klasike.
    const font = typeof raw?.font === "string" && Object.prototype.hasOwnProperty.call(READER_FONTS, raw.font) ? raw.font : DEFAULT_SETTINGS.font;
    return { theme, step, font };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(s: Settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    // Private mode / blocked storage: settings just aren't remembered.
  }
}

// 3a: the reading place in this browser (K8: an offset into the text plus
// the server time of this browser's last saved place, for sync). Blocked
// storage (private mode) just means the book opens at the cover.
function readPlace(key: string): LocalPlace | null {
  try {
    return parseLocalPlace(window.localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writePlace(key: string, place: { offset: number; progress: number; synced: string | null }) {
  try {
    window.localStorage.setItem(key, serializeLocalPlace(place));
  } catch {
    // Not remembered; nothing else changes.
  }
}

type Layout = { width: number; cols: number; contentViews: number; sampleEndView: number | null; anchors: Map<string, number> };

// The views, in order: cover, the text, then (sample) the end page.
type View = { kind: "cover" } | { kind: "content"; k: number } | { kind: "end" };

const CHROME: Record<ReaderTheme, { bg: string; bar: string; text: string; muted: string; border: string }> = {
  light: { bg: "#efebe3", bar: "#faf8f3", text: "#1f1d1a", muted: "#6f6a62", border: "#ddd6c8" },
  sepia: { bg: "#e7dcc3", bar: "#f1e7d0", text: "#4a3b2a", muted: "#7c6a55", border: "#d3c29e" },
  dark: { bg: "#0f0f10", bar: "#18181a", text: "#d8d4cc", muted: "#9a958c", border: "#2e2e32" },
};

// DD (13 Nov): classes of the controls that only show inside a menu or on
// the end page, kept here so a test can guard their 44 px+ size.
// DD follow-up: the ❮ ❯ page buttons use aria-disabled, not disabled,
// so keyboard focus stays on them at the first or last page (a disabled
// button drops focus to the page, and Esc then skips the reader). At the
// end they stay hidden as before, but show faintly while keyboard
// focused, so the focus ring is never drawn around nothing. The drop
// shadow is a class, not an inline style: an inline box-shadow hid the
// shared focus ring (.focus-ring:focus-visible) on these two buttons.
export const CHEVRON_STATE =
  "shadow-[0_1px_6px_rgba(0,0,0,0.15)] opacity-70 hover:opacity-100 aria-disabled:cursor-default aria-disabled:opacity-0 aria-disabled:focus-visible:opacity-60";

export const READER_TAP_CLASSES = {
  tocRow: "focus-ring min-h-12 w-full px-4 py-3 text-left text-sm hover:bg-black/5",
  fontButton: "focus-ring flex h-11 flex-1 items-center justify-center rounded-md border font-serif disabled:opacity-40",
  restart: "focus-ring min-h-11 rounded-sm px-3 text-sm underline underline-offset-2",
} as const;

// DD: Escape with a menu open closes only that menu, and only while the
// reader is on screen (never on the book page after the popup closed).
export function closesOpenMenu(key: string, panel: "none" | "toc" | "aa", readerShown: boolean): boolean {
  return readerShown && key === "Escape" && panel !== "none";
}

// ---- K8 + K10: offsets <-> pages (measured in the frame) ----
type Geo = { root: HTMLElement; index: TextIndex; width: number; cols: number; contentViews: number };
type Rect = { left: number; top: number; width: number; height: number };

// The x of a character across the whole book (column after column), or
// null when it has no box (spaces the layout folded away: the next
// characters are tried).
function xOfOffset(g: Geo, offset: number): number | null {
  const range = g.root.ownerDocument.createRange();
  for (let o = offset; o < Math.min(offset + 64, g.index.text.length); o++) {
    const at = locate(g.index, o);
    if (!at || at.inNode >= at.node.data.length) continue;
    range.setStart(at.node, at.inNode);
    range.setEnd(at.node, at.inNode + 1);
    const r = range.getClientRects()[0];
    if (r && (r.width > 0 || r.height > 0)) return r.left + g.root.scrollLeft;
  }
  return null;
}

function viewOfOffset(g: Geo, offset: number): number | null {
  const x = xOfOffset(g, offset);
  if (x === null) return null;
  return Math.min(g.contentViews - 1, Math.max(0, Math.floor(x / g.width)));
}

/** The page number the bottom bar shows for an offset (cover = 1). */
function pageOfOffset(g: Geo, offset: number): number | null {
  const x = xOfOffset(g, offset);
  if (x === null) return null;
  const column = Math.max(0, Math.floor(x / (g.width / g.cols)));
  return 2 + Math.min(column, g.contentViews * g.cols - 1);
}

/** The first character on content view k. */
function pageStartOffset(g: Geo, k: number): number {
  const n = g.index.text.length;
  if (n === 0) return 0;
  const found = firstOffsetWhere(0, n - 1, (o) => {
    const x = xOfOffset(g, o);
    return x === null ? true : Math.floor(x / g.width) >= k;
  });
  return Math.min(found, n - 1);
}

/** The boxes of [start, end) on the page shown (frame viewport = stage). */
function rectsOf(g: Geo, start: number, end: number): Rect[] {
  const range = rangeFor(g.index, start, end);
  if (!range) return [];
  return Array.from(range.getClientRects())
    .filter((r) => r.width > 0 && r.right > 0 && r.left < g.width)
    .map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }));
}

/** Where the marking bar goes: above the words, or below near the top. */
function barPlaceFor(rects: Rect[], width: number): { top: number; left: number; below: boolean } | null {
  if (rects.length === 0) return null;
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.top + r.height));
  const mid = (Math.min(...rects.map((r) => r.left)) + Math.max(...rects.map((r) => r.left + r.width))) / 2;
  const half = 170;
  const left = Math.max(half + 6, Math.min(width - half - 6, mid));
  const below = top < 76;
  return { top: below ? bottom + 4 : top - 70, left, below };
}

type Measures = {
  bookmarkView: Map<string, number | null>;
  page: Map<string, number | null>;
  chapter: Map<string, string | null>;
};
const NO_MEASURES: Measures = { bookmarkView: new Map(), page: new Map(), chapter: new Map() };

// The marking bar: for new words, or for a saved highlight; on one view.
type Marking =
  | { kind: "new"; start: number; end: number; view: number; rects: Rect[]; bar: { top: number; left: number; below: boolean } | null; done: boolean }
  | { kind: "saved"; id: string; view: number; bar: { top: number; left: number; below: boolean } | null };
type NoteTarget = { kind: "new"; start: number; end: number } | { kind: "saved"; id: string };

export function BookReader({
  data,
  coverUrl,
  onClose,
  endAction,
  devices = false,
  positionKey = null,
  marksBookId = null,
  ratePrompt = null,
}: {
  data: ReaderData;
  coverUrl: string | null;
  onClose: () => void;
  endAction: ReaderEndAction;
  // Build 2: the author's preview shows Phone / Tablet / E-reader frames.
  devices?: boolean;
  // Buyer reader (Renato 11-15, 3a): where this book's place is kept in
  // this browser (owned books only); null keeps no place.
  positionKey?: string | null;
  // K8 + K10: the owned book whose bookmarks, highlights and place sync
  // (null: the free sample and the author's preview have none).
  marksBookId?: string | null;
  // K8 rate prompt (Renato 11-20): owned books only, and only when the
  // reader has no review of this book; null = no bar. onRate gets 1..5.
  ratePrompt?: { bookId: string; onRate: (stars: number) => void } | null;
}) {
  // Only ever rendered in the browser (after the sample has loaded).
  const [settings, setSettings] = useState<Settings>(() => (typeof window === "undefined" ? DEFAULT_SETTINGS : readSettings()));
  const [layout, setLayout] = useState<Layout | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [panel, setPanel] = useState<"none" | "toc" | "aa">("none");
  // K8 rate prompt (k8q3 a): "Jo tani" hides the bar for this book in this browser.
  const [rateLater, setRateLater] = useState(() =>
    ratePrompt && typeof window !== "undefined" ? readRateDismissed(ratePrompt.bookId) : false,
  );
  const [device, setDevice] = useState<ReaderDevice | null>(devices ? "phone" : null);
  const [fit, setFit] = useState(1);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);
  // K8: the offset of the first character on the page shown (null until
  // known), so a new font size or another device opens the same words.
  const placeOffsetRef = useRef<number | null>(null);
  // 3a: the saved place, used once, when the first layout is known.
  const [initialPlace] = useState<LocalPlace | null>(() => (positionKey && typeof window !== "undefined" ? readPlace(positionKey) : null));
  const localPlaceRef = useRef<LocalPlace | null>(initialPlace);
  const restoreRef = useRef<LocalPlace | null | undefined>(undefined);
  if (restoreRef.current === undefined) restoreRef.current = initialPlace;
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  // K8 + K10: the text map of the frame, and the marks.
  const indexRef = useRef<TextIndex | null>(null);
  const [indexVersion, setIndexVersion] = useState(0);
  const [toast, setToast] = useState<
    { kind: "sync"; backTo: number | null } | { kind: "sample" } | { kind: "failed" } | { kind: "limit" } | null
  >(null);
  const onMarksFailure = useCallback((why: MarksFailure) => setToast({ kind: why === "limit" ? "limit" : "failed" }), []);
  const marks = useReaderMarks(marksBookId, onMarksFailure);
  const marking = marksBookId !== null && marks.state.status === "ready";
  const savePlace = marks.savePlace;
  const reanchorMarks = marks.reanchor;
  const [tab, setTab] = useState<PanelTab>("toc");
  // The words being marked (while dragging, then with the bar open).
  const [active, setActive] = useState<Marking | null>(null);
  const [noteFor, setNoteFor] = useState<(NoteTarget & { quote: string; color: HighlightColor; initial: string }) | null>(null);
  const [measures, setMeasures] = useState<Measures>(NO_MEASURES);
  const [notice, setNotice] = useState<number | null>(null);
  const pressRef = useRef<{
    x: number;
    y: number;
    mouse: boolean;
    timer: number | null;
    selecting: boolean;
    anchor: number | null;
    last: number | null;
    handled: boolean;
  } | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const userMovedRef = useRef(false);
  const syncDecidedRef = useRef(false);
  const reanchoredRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // K9 r2: the frame may load fonts only from this site's /fonts/. The
  // origin is read the hydration-safe way: null on the server (fonts
  // blocked, Klasike shows), the real origin in the browser.
  const origin = useSyncExternalStore(subscribeNever, readOrigin, readNoOrigin);
  const srcDoc = useMemo(() => buildReaderFrameDoc(data.html, origin), [data.html, origin]);

  const views: View[] = useMemo(() => {
    const list: View[] = [{ kind: "cover" }];
    for (let k = 0; k < (layout?.contentViews ?? 1); k++) list.push({ kind: "content", k });
    if (data.mode === "sample") list.push({ kind: "end" });
    return list;
  }, [layout?.contentViews, data.mode]);

  const relayout = useCallback(() => {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const root = doc?.getElementById("lb-root");
    if (!iframe || !doc || !root) return;
    const width = iframe.clientWidth;
    const height = iframe.clientHeight;
    if (width < 50 || height < 50) return;
    const cols = width >= 860 && width > height * 1.15 ? 2 : 1;
    const pad = width < 480 ? 22 : cols === 2 ? 52 : 44;
    const padY = height < 620 ? 28 : 48;
    const theme = READER_THEMES[settings.theme];
    const style = doc.documentElement.style;
    style.setProperty("--lb-cols", String(cols));
    style.setProperty("--lb-pad", `${pad}px`);
    style.setProperty("--lb-pad-y", `${padY}px`);
    style.setProperty("--lb-h", `${height - padY * 2}px`);
    style.setProperty("--lb-scale", String(READER_FONT_STEPS[settings.step]));
    style.setProperty("--lb-font", READER_FONTS[settings.font].stack);
    style.setProperty("--lb-page", theme.page);
    style.setProperty("--lb-text", theme.text);
    style.setProperty("--lb-muted", theme.muted);
    style.setProperty("--lb-rule", theme.rule);
    root.scrollLeft = 0;
    if (!indexRef.current || indexRef.current.nodes[0]?.ownerDocument !== doc) {
      indexRef.current = buildTextIndex(root);
      setIndexVersion((v) => v + 1);
    }
    const contentViews = Math.max(1, Math.ceil((root.scrollWidth - 2) / width));
    const viewOf = (el: Element | null) =>
      el ? Math.min(contentViews - 1, Math.max(0, Math.floor((el.getBoundingClientRect().left + root.scrollLeft) / width))) : null;
    const anchors = new Map<string, number>();
    for (const entry of data.toc) {
      const v = viewOf(doc.getElementById(entry.id));
      if (v !== null) anchors.set(entry.id, v);
    }
    setLayout({ width, cols, contentViews, sampleEndView: viewOf(doc.getElementById("lb-sample-end")), anchors });
  }, [settings, data.toc]);

  // The frame's measures for the current layout (null before the first).
  const geoOf = useCallback((l: Layout | null): Geo | null => {
    const root = iframeRef.current?.contentDocument?.getElementById("lb-root");
    const index = indexRef.current;
    if (!l || !root || !index) return null;
    return { root, index, width: l.width, cols: l.cols, contentViews: l.contentViews };
  }, []);

  // Keep the reader on the same place in the book when the layout changes.
  useLayoutEffect(() => {
    if (!layout) return;
    // 3a: the saved place is used once, decided here and not inside the
    // updater (audit r1 M2: StrictMode runs updaters twice).
    const saved = restoreRef.current;
    if (saved != null) {
      restoreRef.current = null;
      progressRef.current = saved.progress;
      placeOffsetRef.current = saved.offset;
    }
    // K8: by the words (offset) when known, else by the share of pages.
    const g = geoOf(layout);
    const byOffset = g && placeOffsetRef.current !== null ? viewOfOffset(g, placeOffsetRef.current) : null;
    setViewIndex((current) => {
      const total = 1 + layout.contentViews + (data.mode === "sample" ? 1 : 0);
      if (saved == null && current === 0) return 0;
      if (byOffset !== null) return Math.min(total - 1, 1 + byOffset);
      const k = Math.round(progressRef.current * (layout.contentViews - 1));
      return Math.min(total - 1, 1 + k);
    });
  }, [layout, data.mode, geoOf]);

  useEffect(() => {
    relayout();
  }, [relayout, device]);

  useEffect(() => {
    const target = stageWrapRef.current;
    if (!target || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (device) {
        const size = DEVICE_SIZE[device];
        setFit(Math.min(1, (target.clientWidth - 24) / size.w, (target.clientHeight - 24) / size.h));
      }
      relayout();
    });
    ro.observe(target);
    return () => ro.disconnect();
  }, [relayout, device]);

  // Turn to the current view inside the frame.
  const view = views[Math.min(viewIndex, views.length - 1)];
  useEffect(() => {
    const root = iframeRef.current?.contentDocument?.getElementById("lb-root");
    if (!root || !layout) return;
    if (view.kind === "content") {
      root.scrollLeft = view.k * layout.width;
      progressRef.current = layout.contentViews > 1 ? view.k / (layout.contentViews - 1) : 0;
      const g = geoOf(layout);
      if (!g || g.index.text.length === 0) return;
      const offset = pageStartOffset(g, view.k);
      placeOffsetRef.current = offset;
      if (!positionKey || restoreRef.current !== null) return;
      const progress = progressOf(offset, g.index.text.length, view.k === layout.contentViews - 1);
      const synced = localPlaceRef.current?.synced ?? null;
      localPlaceRef.current = { offset, progress, synced };
      writePlace(positionKey, { offset, progress, synced });
      // K8: the place syncs a moment after the page stops changing.
      if (!marking) return;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void savePlace(offset, progress).then((at) => {
          if (!at || localPlaceRef.current?.offset !== offset) return;
          const place = { offset, progress, synced: at };
          localPlaceRef.current = place;
          writePlace(positionKey, place);
        });
      }, 1500);
    }
  }, [view, layout, positionKey, marking, savePlace, geoOf]);

  // DD: with Contents or the page-look menu open, Escape closes only that
  // menu and puts focus back on the button that opened it. Listened for on
  // the window (capture), not on the reader, because focus can fall out of
  // the reader (e.g. the bigger-letters button disables at the largest
  // size); cancelling the keydown stops the dialog's own Escape close.
  useEffect(() => {
    if (panel === "none") return;
    function onEscape(e: KeyboardEvent) {
      // The reader stays mounted inside the closed popup until it is opened
      // again, so ignore keys unless it is actually on screen.
      const shown = (rootRef.current?.getClientRects().length ?? 0) > 0;
      if (!closesOpenMenu(e.key, panel, shown)) return;
      e.preventDefault();
      e.stopPropagation();
      setPanel("none");
      rootRef.current?.querySelector<HTMLElement>(`[data-panel-toggle="${panel}"]`)?.focus();
    }
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [panel]);

  // ---- K10: paint the highlights; after a new version, find them again ----
  const highlights = marks.state.data.highlights;
  const bookmarks = marks.state.data.bookmarks;
  const paintMarks = useCallback(() => {
    if (!marking) return;
    const g = geoOf(layout);
    if (!g) return;
    if (!reanchoredRef.current) {
      reanchoredRef.current = true;
      const moves: { id: string; start: number; end: number }[] = [];
      const orphaned: string[] = [];
      for (const h of highlights) {
        const at = findAgain(g.index.text, h);
        if (at && (at.start !== h.start || at.end !== h.end || h.orphaned)) moves.push({ id: h.id, ...at });
        if (!at && !h.orphaned) orphaned.push(h.id);
      }
      if (moves.length + orphaned.length > 0) {
        // Q3 a: said once, when they are first not found.
        if (orphaned.length > 0) setNotice(orphaned.length);
        void reanchorMarks(moves, orphaned);
        return; // painted again with the new places
      }
    }
    indexRef.current = paintHighlights(
      g.root,
      highlights.filter((h) => !h.orphaned).map((h) => ({ id: h.id, start: h.start, end: h.end, color: h.color })),
    );
    // The panel's pages, chapters and this page's bookmark.
    const g2 = geoOf(layout)!;
    const doc = g2.root.ownerDocument;
    const chapters: { offset: number; label: string }[] = [];
    for (const entry of data.toc) {
      const el = doc.getElementById(entry.id);
      const first = el ? (doc.createTreeWalker(el, 4).nextNode() as Text | null) : null;
      const at = first ? g2.index.startOf.get(first) : undefined;
      if (at !== undefined) chapters.push({ offset: at, label: entry.label });
    }
    chapters.sort((x, y) => x.offset - y.offset);
    const chapterOf = (offset: number) => {
      let label: string | null = null;
      for (const c of chapters) {
        if (c.offset > offset) break;
        label = c.label;
      }
      return label;
    };
    const next: Measures = { bookmarkView: new Map(), page: new Map(), chapter: new Map() };
    for (const b of bookmarks) {
      next.bookmarkView.set(b.id, viewOfOffset(g2, b.offset));
      next.page.set(b.id, pageOfOffset(g2, b.offset));
      next.chapter.set(b.id, chapterOf(b.offset));
    }
    for (const h of highlights) {
      if (h.orphaned) continue;
      next.page.set(h.id, pageOfOffset(g2, h.start));
      next.chapter.set(h.id, chapterOf(h.start));
    }
    setMeasures(next);
  }, [marking, layout, highlights, bookmarks, data.toc, geoOf, reanchorMarks]);
  // A layout effect: it changes and measures the frame's DOM (outside
  // React) and keeps the measures, before the page shows.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measures, like relayout
    paintMarks();
  }, [paintMarks, indexVersion]);

  // ---- K8: the most recent place on any device (Q6 a) ----
  const decideSync = useCallback(() => {
    if (!marking || !layout || syncDecidedRef.current || restoreRef.current !== null) return;
    syncDecidedRef.current = true;
    const server = marks.state.data.place;
    if (!server || userMovedRef.current || !serverPlaceWins(server, localPlaceRef.current)) return;
    const g = geoOf(layout);
    const k = g ? viewOfOffset(g, server.offset) : null;
    if (k === null) return;
    if (1 + k === viewIndex) return;
    setToast({ kind: "sync", backTo: viewIndex > 0 ? viewIndex : null });
    setViewIndex(1 + k);
  }, [marking, layout, marks.state.data.place, geoOf, viewIndex]);
  // Decided once, when both the layout and the server's place are known.
  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- runs once (syncDecidedRef)
    decideSync();
  }, [decideSync]);

  // The place is sent at once when the popup closes, the tab hides or the
  // reader goes away (keepalive: the request outlives the page).
  useEffect(() => {
    function flush() {
      if (saveTimerRef.current === null) return;
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      const place = localPlaceRef.current;
      if (place && place.offset !== null) {
        const sent = place.offset;
        void savePlace(place.offset, place.progress, true).then((at) => {
          if (!at || !positionKey || localPlaceRef.current?.offset !== sent) return;
          const next = { offset: sent, progress: place.progress, synced: at };
          localPlaceRef.current = next;
          writePlace(positionKey, next);
        });
      }
    }
    function onHide() {
      if (document.visibilityState === "hidden") flush();
    }
    const dialog = rootRef.current?.closest("dialog");
    dialog?.addEventListener("close", flush);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      dialog?.removeEventListener("close", flush);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, [savePlace, positionKey]);

  // Short lines go after a few seconds.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), toast.kind === "sync" ? 7000 : 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  // While marking, a finger's drag must not scroll or zoom the page
  // (Safari would cancel the drag).
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const onMove = (e: TouchEvent) => {
      if (pressRef.current?.selecting) e.preventDefault();
    };
    layer.addEventListener("touchmove", onMove, { passive: false });
    return () => layer.removeEventListener("touchmove", onMove);
  }, []);

  // Escape closes the note sheet or the bar first (like the menus).
  const barOpen = active !== null && active.view === viewIndex;
  useEffect(() => {
    if (!barOpen && !noteFor) return;
    function onEscape(e: KeyboardEvent) {
      const shown = (rootRef.current?.getClientRects().length ?? 0) > 0;
      if (!shown || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (noteFor) setNoteFor(null);
      else setActive(null);
    }
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [barOpen, noteFor]);

  function pointToOffset(clientX: number, clientY: number): number | null {
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    const index = indexRef.current;
    if (!iframe || !doc || !index) return null;
    const r = iframe.getBoundingClientRect();
    return offsetAtPoint(doc, index, clientX - r.left, clientY - r.top);
  }

  function savedHighlightAt(offset: number) {
    let best: (typeof highlights)[number] | null = null;
    for (const h of highlights) {
      if (h.orphaned || offset < h.start || offset >= h.end) continue;
      if (!best || h.end - h.start < best.end - best.start) best = h;
    }
    return best;
  }

  function showSelection(anchor: number, to: number, done: boolean) {
    const g = geoOf(layout);
    if (!g) return;
    const span = snapToWords(g.index.text, anchor, to);
    if (!span) {
      if (done) setActive(null);
      return;
    }
    const rects = rectsOf(g, span.start, span.end);
    setActive({ kind: "new", ...span, view: viewIndex, rects, bar: done ? barPlaceFor(rects, g.width) : null, done });
  }

  function startSelecting(clientX: number, clientY: number): boolean {
    const off = pointToOffset(clientX, clientY);
    const press = pressRef.current;
    if (off === null || !press) return false;
    press.selecting = true;
    press.anchor = off;
    press.last = off;
    showSelection(off, off, false);
    return true;
  }

  function extendSelecting(clientX: number, clientY: number) {
    const press = pressRef.current;
    if (!press || press.anchor === null) return;
    const off = pointToOffset(clientX, clientY);
    if (off === null || off === press.last) return;
    press.last = off;
    showSelection(press.anchor, off, false);
  }

  function finishSelecting(press: NonNullable<typeof pressRef.current>) {
    if (press.anchor === null) return;
    showSelection(press.anchor, press.last ?? press.anchor, true);
  }

  function openSaved(id: string) {
    const g = geoOf(layout);
    const h = highlights.find((x) => x.id === id);
    if (!g || !h) return;
    setActive({ kind: "saved", id, view: viewIndex, bar: barPlaceFor(rectsOf(g, h.start, h.end), g.width) });
  }

  function markNew(start: number, end: number, color: HighlightColor, note: string | null) {
    const index = indexRef.current;
    setActive(null);
    const a = index ? anchorFor(index.text, start, end) : null;
    if (!a) return;
    void marks.addHighlight({ start: a.start, end: a.end, quote: a.quote, prefix: a.prefix, suffix: a.suffix, color, note });
  }

  function openNote(target: NoteTarget) {
    const index = indexRef.current;
    const saved = target.kind === "saved" ? highlights.find((h) => h.id === target.id) : undefined;
    const quote = saved ? saved.quote : target.kind === "new" && index ? index.text.slice(target.start, target.end) : "";
    setNoteFor({ ...target, quote, color: saved?.color ?? "yellow", initial: saved?.note ?? "" });
  }

  function toggleBookmark() {
    const g = geoOf(layout);
    if (view.kind !== "content" || !g) return;
    if (pageBookmarks.length > 0) void marks.removeBookmarks(pageBookmarks.map((b) => b.id));
    else void marks.addBookmark(pageStartOffset(g, view.k));
  }

  function openAt(offset: number) {
    userMovedRef.current = true;
    const g = geoOf(layout);
    const k = g ? viewOfOffset(g, offset) : null;
    if (k !== null) setViewIndex(1 + k);
    setPanel("none");
  }

  const go = useCallback(
    (delta: number) => {
      // K8: once the reader turns a page, another device's place no longer jumps in.
      userMovedRef.current = true;
      setViewIndex((i) => Math.max(0, Math.min(views.length - 1, i + delta)));
    },
    [views.length],
  );

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
      e.preventDefault();
      go(1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
      e.preventDefault();
      go(-1);
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    pointerRef.current = { x: e.clientX, y: e.clientY };
    const canMark = (marking || data.mode === "sample") && view.kind === "content";
    if (pressRef.current?.timer) window.clearTimeout(pressRef.current.timer);
    const press = {
      x: e.clientX,
      y: e.clientY,
      mouse: e.pointerType === "mouse",
      timer: null as number | null,
      selecting: false,
      anchor: null as number | null,
      last: null as number | null,
      handled: false,
    };
    pressRef.current = press;
    if (!canMark || (press.mouse && e.button !== 0)) return;
    try {
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is only a nicety.
    }
    // Q1 a: a finger presses and holds (a mouse can also just drag).
    press.timer = window.setTimeout(() => {
      press.timer = null;
      if (pressRef.current !== press) return;
      press.handled = true;
      // Q4 a: the free sample has no marking; say why.
      if (data.mode === "sample") setToast({ kind: "sample" });
      else startSelecting(press.x, press.y);
    }, 450);
  }
  function onPointerMove(e: React.PointerEvent) {
    const press = pressRef.current;
    if (!press) return;
    if (press.selecting) {
      extendSelecting(e.clientX, e.clientY);
      return;
    }
    const moved = Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8;
    if (!moved || press.handled) return;
    if (press.timer) {
      window.clearTimeout(press.timer);
      press.timer = null;
    }
    if (press.mouse && marking && view.kind === "content" && e.buttons === 1 && startSelecting(press.x, press.y)) {
      press.handled = true;
      extendSelecting(e.clientX, e.clientY);
    }
  }
  function onPointerUp(e: React.PointerEvent) {
    const start = pointerRef.current;
    const press = pressRef.current;
    pointerRef.current = null;
    pressRef.current = null;
    if (press?.timer) window.clearTimeout(press.timer);
    if (press?.selecting) {
      finishSelecting(press);
      return;
    }
    if (press?.handled) return;
    setPanel("none");
    // A tap while the bar is open only closes it.
    if (barOpen) {
      setActive(null);
      return;
    }
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      go(dx < 0 ? 1 : -1);
      return;
    }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      if (x > 0.62) go(1);
      else if (x < 0.38) go(-1);
      else if (marking && view.kind === "content") {
        // K10: a tap on a saved highlight (middle of the page) opens its bar.
        const off = pointToOffset(e.clientX, e.clientY);
        const hit = off === null ? null : savedHighlightAt(off);
        if (hit) openSaved(hit.id);
      }
    }
  }

  function updateSettings(next: Settings) {
    setSettings(next);
    writeSettings(next);
  }

  function jumpTo(id: string) {
    userMovedRef.current = true;
    const k = layout?.anchors.get(id);
    if (k !== undefined) setViewIndex(1 + k);
    setPanel("none");
  }

  const chrome = CHROME[settings.theme];
  const tocList = (
    <>
            {data.toc.length === 0 ? (
                <p className="px-4 py-3 text-sm" style={{ color: chrome.muted }}>
                  {data.mode === "owned" ? "Ky libër nuk ka tituj kapitujsh." : "Kjo pjesë nuk ka tituj kapitujsh."}
                </p>
              ) : (
                <ul className="max-h-[60vh] overflow-y-auto py-1">
                  <li>
                    <button type="button" onClick={() => (setViewIndex(0), setPanel("none"))} className={READER_TAP_CLASSES.tocRow}>
                      Ballina
                    </button>
                  </li>
                  {data.toc.map((entry) => (
                    <li key={entry.id}>
                      <button type="button" onClick={() => jumpTo(entry.id)} className={READER_TAP_CLASSES.tocRow}>
                        {entry.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
    </>
  );
  const page = READER_THEMES[settings.theme];
  const cols = layout?.cols ?? 1;
  const contentPages = (layout?.contentViews ?? 1) * cols;
  const totalPages = 1 + contentPages + (data.mode === "sample" ? 1 : 0);
  const firstPage = view.kind === "cover" ? 1 : view.kind === "end" ? totalPages : 2 + view.k * cols;
  // ---- K8: bookmarks on this page, and the panel's rows ----
  const pageBookmarks = view.kind === "content" ? bookmarks.filter((b) => measures.bookmarkView.get(b.id) === view.k) : [];
  const bookmarkRows: BookmarkRow[] =
    panel === "toc" && marking
      ? bookmarks.map((b) => ({
          id: b.id,
          page: measures.page.get(b.id) ?? 1,
          chapter: measures.chapter.get(b.id) ?? null,
          onOpen: () => openAt(b.offset),
        }))
      : [];
  const highlightRows: HighlightRow[] =
    panel === "toc" && marking
      ? highlights.map((h) => ({
          ...h,
          page: h.orphaned ? null : (measures.page.get(h.id) ?? null),
          chapter: h.orphaned ? null : (measures.chapter.get(h.id) ?? null),
          onOpen: h.orphaned ? null : () => openAt(h.start),
        }))
      : [];

  const pageLabel =
    view.kind === "content" && cols === 2 ? `${firstPage}–${Math.min(firstPage + 1, totalPages - (data.mode === "sample" ? 1 : 0))}` : String(firstPage);
  const percent = Math.round((viewIndex / Math.max(1, views.length - 1)) * 100);
  const endTick =
    data.mode === "full" && layout?.sampleEndView != null && views.length > 1
      ? ((1 + layout.sampleEndView) / (views.length - 1)) * 100
      : null;
  const atSampleEnd = view.kind === "content" && layout?.sampleEndView === view.k && data.mode === "full";

  // K8 rate prompt (k8f a, 11-20): shown in the bottom strip, in place of
  // the slider, so it never covers the book's last lines.
  const showRateBar =
    ratePrompt !== null &&
    rateBarVisible({
      enabled: true,
      later: rateLater,
      mode: data.mode,
      onContent: view.kind === "content",
      view: view.kind === "content" ? view.k : -1,
      lastView: layout ? layout.contentViews - 1 : null,
      busy: toast !== null || barOpen || noteFor !== null,
    });

  const stage = (
    <div className="relative h-full w-full overflow-hidden" style={{ background: page.page }}>
      <iframe
        ref={iframeRef}
        title={`Teksti i librit ${data.title}`}
        sandbox={READER_FRAME_SANDBOX}
        srcDoc={srcDoc}
        onLoad={relayout}
        tabIndex={-1}
        className="absolute inset-0 h-full w-full border-0"
        style={{ visibility: view.kind === "content" ? "visible" : "hidden", background: page.page }}
      />
      {view.kind === "content" && cols === 2 && (
        // The fold between the two pages of a spread.
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-1/2 w-16 -translate-x-1/2"
          style={{
            background:
              settings.theme === "dark"
                ? "linear-gradient(90deg, transparent, rgba(0,0,0,0.35) 50%, transparent)"
                : "linear-gradient(90deg, transparent, rgba(60,40,10,0.09) 46%, rgba(60,40,10,0.16) 50%, rgba(60,40,10,0.09) 54%, transparent)",
          }}
        />
      )}
      {view.kind === "cover" && (
        <div className="absolute inset-0 flex items-center justify-center p-6 sm:p-10">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a public cover, shown as the book's first page
            <img
              src={coverUrl}
              alt={`Ballina e librit ${data.title}`}
              className="max-h-full max-w-full rounded-[2px] object-contain shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
            />
          ) : (
            <TitlePage title={data.title} author={data.author} color={page.text} muted={page.muted} />
          )}
        </div>
      )}
      {view.kind === "end" && (
        <EndPage title={data.title} percent={data.approximatePercent} endAction={endAction} color={page.text} muted={page.muted} onRestart={() => setViewIndex(0)} />
      )}
      {/* K10: the words being marked. */}
      {barOpen && active.kind === "new" && (
        <div aria-hidden="true" className="pointer-events-none absolute inset-0">
          {active.rects.map((r, i) => (
            <span
              key={i}
              className="absolute bg-[rgba(70,130,220,0.32)]"
              style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            />
          ))}
        </div>
      )}
      {/* The clear layer: taps, swipes, marking; also keeps the text unselectable. */}
      <div
        ref={layerRef}
        aria-hidden="true"
        className="absolute inset-0 touch-pan-y select-none [-webkit-touch-callout:none]"
        style={{ pointerEvents: view.kind === "end" ? "none" : "auto" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          pointerRef.current = null;
          if (pressRef.current?.timer) window.clearTimeout(pressRef.current.timer);
          if (pressRef.current?.selecting) finishSelecting(pressRef.current);
          pressRef.current = null;
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      {barOpen && active.bar && (active.kind === "saved" || active.done) && !noteFor && (
        <SelectionBar
          {...active.bar}
          current={active.kind === "saved" ? (highlights.find((h) => h.id === active.id)?.color ?? null) : null}
          isNew={active.kind === "new"}
          onColor={(c) => {
            if (active.kind === "new") markNew(active.start, active.end, c, null);
            else {
              void marks.updateHighlight(active.id, { color: c });
              setActive(null);
            }
          }}
          onNote={() => openNote(active.kind === "new" ? { kind: "new", start: active.start, end: active.end } : { kind: "saved", id: active.id })}
          onDelete={() => {
            if (active.kind === "saved") void marks.removeHighlight(active.id);
            setActive(null);
          }}
        />
      )}
      {noteFor && (
        <NoteSheet
          chrome={chrome}
          quote={noteFor.quote.length > 300 ? `${noteFor.quote.slice(0, 300)}…` : noteFor.quote}
          color={noteFor.color}
          initial={noteFor.initial}
          onCancel={() => setNoteFor(null)}
          onSave={(value) => {
            const note = value.trim() === "" ? null : value.trim();
            if (noteFor.kind === "new") markNew(noteFor.start, noteFor.end, noteFor.color, note);
            else {
              void marks.updateHighlight(noteFor.id, { note });
              setActive(null);
            }
            setNoteFor(null);
          }}
        />
      )}
      {toast && (
        <ReaderToast>
          {toast.kind === "sync" ? (
            <>
              <span>Vazhdoni nga vendi ku latë</span>
              {toast.backTo !== null && (
                <button
                  type="button"
                  onClick={() => {
                    setViewIndex(toast.backTo!);
                    setToast(null);
                  }}
                  className="focus-ring min-h-11 font-semibold text-[#f0c36a] underline underline-offset-2"
                >
                  Kthehu te faqja {toast.backTo === 0 ? 1 : 2 + (toast.backTo - 1) * cols}
                </button>
              )}
            </>
          ) : toast.kind === "sample" ? (
            <span>Theksimet janë për librat që keni blerë.</span>
          ) : toast.kind === "limit" ? (
            <span>Keni arritur kufirin për këtë libër.</span>
          ) : (
            <span>Nuk u ruajt. Provoni përsëri.</span>
          )}
        </ReaderToast>
      )}
      {notice !== null && (
        <ChangedVersionNotice
          count={notice}
          onClose={() => setNotice(null)}
          onShow={() => {
            setNotice(null);
            setTab("hl");
            setPanel("toc");
          }}
        />
      )}
      {atSampleEnd && (
        <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#c0841a] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow">
          Fundi i pjesës falas
        </p>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full flex-col outline-none"
      style={{ background: chrome.bg, color: chrome.text }}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      {/* Top bar: Back / title / Contents / Aa */}
      <div className="relative z-20 flex shrink-0 items-center gap-2 border-b px-2 py-1.5 sm:px-4" style={{ background: chrome.bar, borderColor: chrome.border }}>
        <button type="button" onClick={() => (setPanel("none"), onClose())} aria-label="Mbyllni leximin" className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-black/5">
          <IconClose className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate font-serif text-[15px] font-semibold leading-tight">{data.title}</p>
          <p className="truncate text-xs leading-tight" style={{ color: chrome.muted }}>
            {data.mode === "full" ? "Pamja paraprake e librit të plotë" : data.mode === "owned" ? (data.author ? `nga ${data.author}` : "") : data.author ? `nga ${data.author} · Pjesë falas` : "Pjesë falas"}
          </p>
        </div>
        {marking && (
          <button
            type="button"
            aria-label={pageBookmarks.length > 0 ? "Hiqni faqerojtësin e kësaj faqeje" : "Shënoni këtë faqe me faqerojtës"}
            aria-pressed={pageBookmarks.length > 0}
            disabled={view.kind !== "content"}
            onClick={toggleBookmark}
            className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-black/5 disabled:opacity-40"
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill={pageBookmarks.length > 0 ? "#c0841a" : "none"}
              stroke={pageBookmarks.length > 0 ? "#c0841a" : "currentColor"}
              strokeWidth="1.8"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 3.5h12v17l-6-4.2-6 4.2z" />
            </svg>
          </button>
        )}
        <ToolbarButton label="Përmbajtja" word="Përmbajtja" panelKey="toc" active={panel === "toc"} onClick={() => setPanel(panel === "toc" ? "none" : "toc")}>
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
          </svg>
        </ToolbarButton>
        <ToolbarButton label="Madhësia e shkronjave dhe ngjyra e faqes" panelKey="aa" active={panel === "aa"} onClick={() => setPanel(panel === "aa" ? "none" : "aa")}>
          <span className="font-serif text-[17px] leading-none" aria-hidden="true">
            A<span className="text-[13px]">a</span>
          </span>
        </ToolbarButton>

        {panel === "toc" && marking && (
          <MarksPanel
            chrome={chrome}
            tab={tab}
            setTab={setTab}
            contents={tocList}
            bookmarks={bookmarkRows}
            highlights={highlightRows}
            onRemoveBookmark={(id) => void marks.removeBookmarks([id])}
            onRemoveHighlight={(id) => void marks.removeHighlight(id)}
          />
        )}
        {panel === "toc" && !marking && (
          <Panel chrome={chrome} title="Përmbajtja">
            {tocList}
            {data.mode === "sample" && (
              <p className="border-t px-4 py-2.5 text-xs" style={{ color: chrome.muted, borderColor: chrome.border }}>
                Shfaqen vetëm kapitujt që janë në këtë pjesë.
              </p>
            )}
          </Panel>
        )}
        {panel === "aa" && (
          <Panel chrome={chrome} title="Pamja e faqes">
            <div className="flex items-center justify-between gap-3 px-4 py-3">
              <button
                type="button"
                aria-label="Shkronja më të vogla"
                disabled={settings.step === 0}
                onClick={() => updateSettings({ ...settings, step: settings.step - 1 })}
                className={`${READER_TAP_CLASSES.fontButton} text-sm`}
                style={{ borderColor: chrome.border }}
              >
                A
              </button>
              <span className="w-10 text-center text-xs tabular-nums" style={{ color: chrome.muted }}>
                {Math.round(READER_FONT_STEPS[settings.step] * 100)}%
              </span>
              <button
                type="button"
                aria-label="Shkronja më të mëdha"
                disabled={settings.step === READER_FONT_STEPS.length - 1}
                onClick={() => updateSettings({ ...settings, step: settings.step + 1 })}
                className={`${READER_TAP_CLASSES.fontButton} text-xl`}
                style={{ borderColor: chrome.border }}
              >
                A
              </button>
            </div>
            {/* K9 (Renato 11-14, 1a): each choice is written in its own font. */}
            <style>{READER_FONT_FACES}</style>
            <div className="flex gap-2 px-4 pb-3" role="radiogroup" aria-label="Shkronjat">
              {(Object.keys(READER_FONTS) as ReaderFont[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={settings.font === key}
                  onClick={() => updateSettings({ ...settings, font: key })}
                  className="focus-ring flex h-12 flex-1 items-center justify-center rounded-md border text-[15px]"
                  style={{
                    fontFamily: READER_FONTS[key].stack,
                    borderColor: settings.font === key ? "#c0841a" : chrome.border,
                    boxShadow: settings.font === key ? "0 0 0 1px #c0841a" : undefined,
                  }}
                >
                  {READER_FONTS[key].label}
                </button>
              ))}
            </div>
            <div className="flex gap-2 px-4 pb-4" role="radiogroup" aria-label="Ngjyra e faqes">
              {(
                [
                  ["light", "E bardhë"],
                  ["sepia", "Sepia"],
                  ["dark", "E errët"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="radio"
                  aria-checked={settings.theme === key}
                  onClick={() => updateSettings({ ...settings, theme: key })}
                  className="focus-ring flex h-12 flex-1 flex-col items-center justify-center rounded-md border text-xs"
                  style={{
                    background: READER_THEMES[key].page,
                    color: READER_THEMES[key].text,
                    borderColor: settings.theme === key ? "#c0841a" : chrome.border,
                    boxShadow: settings.theme === key ? "0 0 0 1px #c0841a" : undefined,
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Panel>
        )}
      </div>

      {devices && (
        <div className="flex shrink-0 justify-center gap-1 border-b px-2 py-0.5" style={{ background: chrome.bar, borderColor: chrome.border }} role="radiogroup" aria-label="Pajisja">
          {(Object.keys(DEVICE_SIZE) as ReaderDevice[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={device === key}
              onClick={() => setDevice(key)}
              className="focus-ring flex min-h-11 items-center rounded-full px-4 text-sm font-medium"
              style={device === key ? { background: chrome.text, color: chrome.bar } : { color: chrome.muted }}
            >
              {DEVICE_SIZE[key].label}
            </button>
          ))}
        </div>
      )}

      {/* The page area */}
      <div ref={stageWrapRef} className="relative min-h-0 flex-1">
        {device ? (
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden">
            <div
              className="shrink-0 rounded-[28px] p-3 shadow-[0_20px_50px_rgba(0,0,0,0.3)]"
              style={{
                width: DEVICE_SIZE[device].w + 24,
                height: DEVICE_SIZE[device].h + 24,
                background: device === "ereader" ? "#3b3b3b" : "#111",
                transform: `scale(${fit})`,
                filter: device === "ereader" ? "grayscale(1) contrast(1.05)" : undefined,
              }}
            >
              <div className="h-full w-full overflow-hidden rounded-[18px]">{stage}</div>
            </div>
          </div>
        ) : (
          <div className="absolute inset-0 sm:inset-x-6 sm:inset-y-4">
            <div className="h-full w-full overflow-hidden sm:rounded-[3px] sm:shadow-[0_10px_40px_rgba(0,0,0,0.18)]">{stage}</div>
          </div>
        )}
        <button
          type="button"
          aria-label="Faqja e mëparshme"
          onClick={() => {
            if (viewIndex > 0) go(-1);
          }}
          aria-disabled={viewIndex === 0}
          className={`focus-ring absolute left-1 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full sm:flex ${CHEVRON_STATE}`}
          style={{ background: chrome.bar, color: chrome.text }}
        >
          <Chevron dir="left" />
        </button>
        <button
          type="button"
          aria-label="Faqja tjetër"
          onClick={() => {
            if (viewIndex < views.length - 1) go(1);
          }}
          aria-disabled={viewIndex >= views.length - 1}
          className={`focus-ring absolute right-1 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full sm:flex ${CHEVRON_STATE}`}
          style={{ background: chrome.bar, color: chrome.text }}
        >
          <Chevron dir="right" />
        </button>
      </div>

      {/* Bottom: slider + "Faqe x nga y · %" */}
      <div className="shrink-0 border-t px-4 pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-0.5 sm:px-8" style={{ background: chrome.bar, borderColor: chrome.border }}>
        {/* k8f a: on the last page the rate prompt takes the slider's place;
            the slider stays in the layout (invisible) so nothing moves. */}
        <div className="relative mx-auto max-w-3xl">
          <div className={showRateBar ? "invisible" : undefined}>
          <input
            type="range"
            min={0}
            max={Math.max(0, views.length - 1)}
            value={Math.min(viewIndex, views.length - 1)}
            onChange={(e) => {
              userMovedRef.current = true;
              setViewIndex(Number(e.target.value));
            }}
            aria-label="Faqja"
            aria-valuetext={`Faqe ${pageLabel} nga ${totalPages}`}
            className="block h-11 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#c0841a] [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--lb-track)] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--lb-track)] [&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#c0841a] [&::-webkit-slider-thumb]:shadow"
            style={{ ["--lb-track" as string]: chrome.border }}
          />
          {endTick !== null && (
            <span
              aria-hidden="true"
              title="Këtu mbaron pjesa që shohin lexuesit"
              className="pointer-events-none absolute top-[15px] h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-[#7a4f0b]"
              style={{ left: `calc(8px + (100% - 16px) * ${endTick / 100})` }}
            />
          )}
          <p className="-mt-1.5 text-center text-xs tabular-nums" style={{ color: chrome.muted }}>
            Faqe {pageLabel} nga {totalPages} · {percent}%
          </p>
          </div>
          {showRateBar && ratePrompt && (
            <RatePromptBar
              color={chrome.text}
              onRate={ratePrompt.onRate}
              onLater={() => {
                writeRateDismissed(ratePrompt.bookId);
                setRateLater(true);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// DD (Renato 13 Nov): every reader control is at least 44 px. Contents
// also shows its word on computer and tablet; on phone, icons only.
function ToolbarButton({
  label,
  word,
  panelKey,
  active,
  onClick,
  children,
}: {
  label: string;
  word?: string;
  panelKey: "toc" | "aa";
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={active}
      data-panel-toggle={panelKey}
      onClick={onClick}
      className={`focus-ring flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-full hover:bg-black/5 ${word ? "sm:px-3" : ""} ${active ? "bg-black/10" : ""}`}
    >
      {children}
      {word && (
        <span className="hidden text-sm sm:inline" aria-hidden="true">
          {word}
        </span>
      )}
    </button>
  );
}

function Panel({ chrome, title, children }: { chrome: (typeof CHROME)[ReaderTheme]; title: string; children: ReactNode }) {
  return (
    <div
      role="dialog"
      aria-label={title}
      className="absolute right-2 top-full z-30 mt-1 w-[min(20rem,calc(100vw-1rem))] overflow-hidden rounded-lg border shadow-xl"
      style={{ background: chrome.bar, borderColor: chrome.border, color: chrome.text }}
    >
      <p className="border-b px-4 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ borderColor: chrome.border, color: chrome.muted }}>
        {title}
      </p>
      {children}
    </div>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

function TitlePage({ title, author, color, muted }: { title: string; author: string | null; color: string; muted: string }) {
  return (
    <div className="flex h-full max-h-[34rem] w-full max-w-[22rem] flex-col items-center justify-center border px-6 text-center" style={{ borderColor: muted, color }}>
      <p className="font-serif text-3xl leading-tight">{title}</p>
      {author && (
        <p className="mt-6 text-sm uppercase tracking-[0.2em]" style={{ color: muted }}>
          {author}
        </p>
      )}
    </div>
  );
}

function EndPage({
  title,
  percent,
  endAction,
  color,
  muted,
  onRestart,
}: {
  title: string;
  percent: number;
  endAction: ReaderEndAction;
  color: string;
  muted: string;
  onRestart: () => void;
}) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center p-8">
      <div className="max-w-sm text-center" style={{ color }}>
        <p className="text-xs font-semibold uppercase tracking-[0.18em]" style={{ color: muted }}>
          Fundi i pjesës falas
        </p>
        <p className="mt-4 font-serif text-2xl leading-snug">Ju pëlqeu fillimi i «{title}»?</p>
        <p className="mt-3 text-sm leading-relaxed" style={{ color: muted }}>
          Kjo pjesë është rreth {percent}% e librit.
        </p>
        <div className="mt-7 flex flex-col items-center gap-3">
          {endAction && (
            <button
              type="button"
              onClick={endAction.onSelect}
              className="focus-ring w-full max-w-[16rem] rounded-full bg-[#1e3a32] px-5 py-3 text-sm font-semibold text-white hover:bg-[#16302a]"
            >
              {endAction.label}
            </button>
          )}
          <button type="button" onClick={onRestart} className={READER_TAP_CLASSES.restart} style={{ color: muted }}>
            Lexoni përsëri nga fillimi
          </button>
        </div>
      </div>
    </div>
  );
}

// K8 rate prompt (Renato 11-20, k8q1 b; k8f a after audit r1 M1): on the
// last page it takes the slider's place in the bottom strip, so it never
// covers the book's text. Stars are 44 px tall (40 px wide on a phone,
// 36 px under 360 px, with 11 px words, Renato 11-20); a star opens the
// review form.
export function RatePromptBar({
  onRate,
  onLater,
  color,
}: {
  onRate: (stars: number) => void;
  onLater: () => void;
  color: string;
}) {
  // Fills the slider's box (absolute); the slider stays there, invisible,
  // so the strip and the page above never change size.
  return (
    <div
      role="group"
      aria-label={RATE_PROMPT_TEXT}
      className="absolute inset-0 z-10 flex items-center justify-center gap-1.5 max-[359px]:-inset-x-2 max-[359px]:gap-1 sm:gap-4"
      style={{ color }}
    >
      <span className="w-[5.5rem] text-xs leading-tight max-[359px]:w-[4.25rem] max-[359px]:text-[11px] sm:w-auto sm:text-sm">{RATE_PROMPT_TEXT}</span>
      <span className="flex">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onRate(n)}
            aria-label={n === 1 ? "1 yll" : `${n} yje`}
            className="focus-ring flex h-11 w-10 items-center justify-center rounded-full text-[#c0841a] hover:bg-black/5 max-[359px]:w-9 sm:w-11"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-7 w-7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
              <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />
            </svg>
          </button>
        ))}
      </span>
      <button type="button" onClick={onLater} className="focus-ring min-h-11 whitespace-nowrap px-1 text-xs underline underline-offset-2 max-[359px]:text-[11px] sm:text-sm">
        {RATE_PROMPT_LATER}
      </button>
    </div>
  );
}
