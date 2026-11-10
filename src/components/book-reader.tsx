"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { IconClose } from "@/components/icons";
import {
  READER_FONT_STEPS,
  READER_FRAME_SANDBOX,
  READER_THEMES,
  buildReaderFrameDoc,
  type ReaderTheme,
} from "@/lib/reader-frame-doc";

// PREVIEW-READER-1: the page-turning reader (readers' sample and the
// author's whole-book preview). The book text lives in an iframe that is
// sandboxed with no permission to run scripts and carries its own CSP (see
// reader-frame-doc.ts); this component lays it out in CSS columns and
// turns pages from outside the frame. Taps, swipes and keys are caught
// by a clear layer over the frame (Safari does not deliver events into a
// script-less sandboxed frame), which also means the text can't be
// selected or copied from the sample.

export type ReaderData = {
  title: string;
  author: string | null;
  mode: "sample" | "full";
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

const SETTINGS_KEY = "librum-reader-settings";
type Settings = { theme: ReaderTheme; step: number };
const DEFAULT_SETTINGS: Settings = { theme: "light", step: 2 };

function readSettings(): Settings {
  try {
    const raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? "null") as Partial<Settings> | null;
    const theme = raw?.theme && raw.theme in READER_THEMES ? raw.theme : DEFAULT_SETTINGS.theme;
    const step =
      typeof raw?.step === "number" && raw.step >= 0 && raw.step < READER_FONT_STEPS.length ? Math.floor(raw.step) : DEFAULT_SETTINGS.step;
    return { theme, step };
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

type Layout = { width: number; cols: number; contentViews: number; sampleEndView: number | null; anchors: Map<string, number> };

// The views, in order: cover, the text, then (sample) the end page.
type View = { kind: "cover" } | { kind: "content"; k: number } | { kind: "end" };

const CHROME: Record<ReaderTheme, { bg: string; bar: string; text: string; muted: string; border: string }> = {
  light: { bg: "#efebe3", bar: "#faf8f3", text: "#1f1d1a", muted: "#6f6a62", border: "#ddd6c8" },
  sepia: { bg: "#e7dcc3", bar: "#f1e7d0", text: "#4a3b2a", muted: "#7c6a55", border: "#d3c29e" },
  dark: { bg: "#0f0f10", bar: "#18181a", text: "#d8d4cc", muted: "#9a958c", border: "#2e2e32" },
};

export function BookReader({
  data,
  coverUrl,
  onClose,
  endAction,
  devices = false,
}: {
  data: ReaderData;
  coverUrl: string | null;
  onClose: () => void;
  endAction: ReaderEndAction;
  // Build 2: the author's preview shows Phone / Tablet / E-reader frames.
  devices?: boolean;
}) {
  // Only ever rendered in the browser (after the sample has loaded).
  const [settings, setSettings] = useState<Settings>(() => (typeof window === "undefined" ? DEFAULT_SETTINGS : readSettings()));
  const [layout, setLayout] = useState<Layout | null>(null);
  const [viewIndex, setViewIndex] = useState(0);
  const [panel, setPanel] = useState<"none" | "toc" | "aa">("none");
  const [device, setDevice] = useState<ReaderDevice | null>(devices ? "phone" : null);
  const [fit, setFit] = useState(1);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef(0);
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const srcDoc = useMemo(() => buildReaderFrameDoc(data.html), [data.html]);

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
    style.setProperty("--lb-page", theme.page);
    style.setProperty("--lb-text", theme.text);
    style.setProperty("--lb-muted", theme.muted);
    style.setProperty("--lb-rule", theme.rule);
    root.scrollLeft = 0;
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

  // Keep the reader on the same place in the book when the layout changes.
  useLayoutEffect(() => {
    if (!layout) return;
    setViewIndex((current) => {
      const total = 1 + layout.contentViews + (data.mode === "sample" ? 1 : 0);
      if (current === 0) return 0;
      const k = Math.round(progressRef.current * (layout.contentViews - 1));
      return Math.min(total - 1, 1 + k);
    });
  }, [layout, data.mode]);

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
    }
  }, [view, layout]);

  const go = useCallback(
    (delta: number) => setViewIndex((i) => Math.max(0, Math.min(views.length - 1, i + delta))),
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
  }
  function onPointerUp(e: React.PointerEvent) {
    const start = pointerRef.current;
    pointerRef.current = null;
    setPanel("none");
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
    }
  }

  function updateSettings(next: Settings) {
    setSettings(next);
    writeSettings(next);
  }

  function jumpTo(id: string) {
    const k = layout?.anchors.get(id);
    if (k !== undefined) setViewIndex(1 + k);
    setPanel("none");
  }

  const chrome = CHROME[settings.theme];
  const page = READER_THEMES[settings.theme];
  const cols = layout?.cols ?? 1;
  const contentPages = (layout?.contentViews ?? 1) * cols;
  const totalPages = 1 + contentPages + (data.mode === "sample" ? 1 : 0);
  const firstPage = view.kind === "cover" ? 1 : view.kind === "end" ? totalPages : 2 + view.k * cols;
  const pageLabel =
    view.kind === "content" && cols === 2 ? `${firstPage}–${Math.min(firstPage + 1, totalPages - (data.mode === "sample" ? 1 : 0))}` : String(firstPage);
  const percent = Math.round((viewIndex / Math.max(1, views.length - 1)) * 100);
  const endTick =
    data.mode === "full" && layout?.sampleEndView != null && views.length > 1
      ? ((1 + layout.sampleEndView) / (views.length - 1)) * 100
      : null;
  const atSampleEnd = view.kind === "content" && layout?.sampleEndView === view.k && data.mode === "full";

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
      {/* The clear layer: taps, swipes; also keeps the text unselectable. */}
      <div
        aria-hidden="true"
        className="absolute inset-0 touch-pan-y select-none"
        style={{ pointerEvents: view.kind === "end" ? "none" : "auto" }}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (pointerRef.current = null)}
      />
      {atSampleEnd && (
        <p className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 whitespace-nowrap rounded-full bg-[#c0841a] px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-white shadow">
          Fundi i pjesës falas
        </p>
      )}
    </div>
  );

  return (
    <div
      className="flex h-full w-full flex-col outline-none"
      style={{ background: chrome.bg, color: chrome.text }}
      onKeyDown={onKeyDown}
      tabIndex={-1}
    >
      {/* Top bar: Back / title / Contents / Aa */}
      <div className="relative z-20 flex shrink-0 items-center gap-2 border-b px-2 py-1.5 sm:px-4" style={{ background: chrome.bar, borderColor: chrome.border }}>
        <button type="button" onClick={onClose} aria-label="Mbyllni leximin" className="focus-ring flex size-10 items-center justify-center rounded-full hover:bg-black/5">
          <IconClose className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="truncate font-serif text-[15px] font-semibold leading-tight">{data.title}</p>
          <p className="truncate text-xs leading-tight" style={{ color: chrome.muted }}>
            {data.mode === "full" ? "Pamja paraprake e librit të plotë" : data.author ? `nga ${data.author} · Pjesë falas` : "Pjesë falas"}
          </p>
        </div>
        <ToolbarButton label="Përmbajtja" active={panel === "toc"} onClick={() => setPanel(panel === "toc" ? "none" : "toc")}>
          <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
          </svg>
        </ToolbarButton>
        <ToolbarButton label="Madhësia e shkronjave dhe ngjyra e faqes" active={panel === "aa"} onClick={() => setPanel(panel === "aa" ? "none" : "aa")}>
          <span className="font-serif text-[17px] leading-none" aria-hidden="true">
            A<span className="text-[13px]">a</span>
          </span>
        </ToolbarButton>

        {panel === "toc" && (
          <Panel chrome={chrome} title="Përmbajtja">
            {data.toc.length === 0 ? (
              <p className="px-4 py-3 text-sm" style={{ color: chrome.muted }}>
                Kjo pjesë nuk ka tituj kapitujsh.
              </p>
            ) : (
              <ul className="max-h-[60vh] overflow-y-auto py-1">
                <li>
                  <button type="button" onClick={() => (setViewIndex(0), setPanel("none"))} className="focus-ring w-full px-4 py-2.5 text-left text-sm hover:bg-black/5">
                    Ballina
                  </button>
                </li>
                {data.toc.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" onClick={() => jumpTo(entry.id)} className="focus-ring w-full px-4 py-2.5 text-left text-sm hover:bg-black/5">
                      {entry.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
                className="focus-ring flex h-10 flex-1 items-center justify-center rounded-md border font-serif text-sm disabled:opacity-40"
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
                className="focus-ring flex h-10 flex-1 items-center justify-center rounded-md border font-serif text-xl disabled:opacity-40"
                style={{ borderColor: chrome.border }}
              >
                A
              </button>
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
        <div className="flex shrink-0 justify-center gap-1 border-b px-2 py-1.5" style={{ background: chrome.bar, borderColor: chrome.border }} role="radiogroup" aria-label="Pajisja">
          {(Object.keys(DEVICE_SIZE) as ReaderDevice[]).map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={device === key}
              onClick={() => setDevice(key)}
              className="focus-ring rounded-full px-3 py-1 text-xs font-medium"
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
          onClick={() => go(-1)}
          disabled={viewIndex === 0}
          className="focus-ring absolute left-1 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full opacity-70 hover:opacity-100 disabled:opacity-0 sm:flex"
          style={{ background: chrome.bar, color: chrome.text, boxShadow: "0 1px 6px rgba(0,0,0,0.15)" }}
        >
          <Chevron dir="left" />
        </button>
        <button
          type="button"
          aria-label="Faqja tjetër"
          onClick={() => go(1)}
          disabled={viewIndex >= views.length - 1}
          className="focus-ring absolute right-1 top-1/2 z-10 hidden size-11 -translate-y-1/2 items-center justify-center rounded-full opacity-70 hover:opacity-100 disabled:opacity-0 sm:flex"
          style={{ background: chrome.bar, color: chrome.text, boxShadow: "0 1px 6px rgba(0,0,0,0.15)" }}
        >
          <Chevron dir="right" />
        </button>
      </div>

      {/* Bottom: slider + "Faqe x nga y · %" */}
      <div className="shrink-0 border-t px-4 pb-[max(0.6rem,env(safe-area-inset-bottom))] pt-2 sm:px-8" style={{ background: chrome.bar, borderColor: chrome.border }}>
        <div className="relative mx-auto max-w-3xl">
          <input
            type="range"
            min={0}
            max={Math.max(0, views.length - 1)}
            value={Math.min(viewIndex, views.length - 1)}
            onChange={(e) => setViewIndex(Number(e.target.value))}
            aria-label="Faqja"
            aria-valuetext={`Faqe ${pageLabel} nga ${totalPages}`}
            className="block h-5 w-full cursor-pointer appearance-none bg-transparent [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#c0841a] [&::-moz-range-track]:h-1 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:bg-[var(--lb-track)] [&::-webkit-slider-runnable-track]:h-1 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--lb-track)] [&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#c0841a] [&::-webkit-slider-thumb]:shadow"
            style={{ ["--lb-track" as string]: chrome.border }}
          />
          {endTick !== null && (
            <span
              aria-hidden="true"
              title="Këtu mbaron pjesa që shohin lexuesit"
              className="pointer-events-none absolute top-[3px] h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-[#7a4f0b]"
              style={{ left: `calc(8px + (100% - 16px) * ${endTick / 100})` }}
            />
          )}
          <p className="mt-1 text-center text-xs tabular-nums" style={{ color: chrome.muted }}>
            Faqe {pageLabel} nga {totalPages} · {percent}%
          </p>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={active}
      onClick={onClick}
      className={`focus-ring flex size-10 items-center justify-center rounded-full hover:bg-black/5 ${active ? "bg-black/10" : ""}`}
    >
      {children}
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
          <button type="button" onClick={onRestart} className="focus-ring rounded-sm text-sm underline underline-offset-2" style={{ color: muted }}>
            Lexoni përsëri nga fillimi
          </button>
        </div>
      </div>
    </div>
  );
}
