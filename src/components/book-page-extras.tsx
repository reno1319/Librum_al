"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconClose, IconShare } from "@/components/icons";

// P1 book page (design B, 2026-11-10): the small browser-side
// pieces of the new book page. Each one renders the plain, complete
// content on the server, so without JavaScript nothing is hidden:
// - ExpandableText: the full text; once the browser has measured it and
//   it is taller than `lines` lines, it folds and "Lexo më shumë" opens it.
// - CoverZoom: a link to the cover image itself; with JavaScript it opens
//   the large cover in a popup instead.
// - ShareIconButton (Amazon page, item 29): the round share button on the
//   cover -- the phone's own share sheet where there is one, otherwise it
//   copies the link ("U kopjua").
// - TileStrip (item 5): the quick-fact tiles in one row, five at a time
//   on a computer with an arrow for the rest; phones swipe.
// (CopyLinkButton moved into the share row, src/components/share-buttons.tsx.)

export function ExpandableText({
  children,
  lines = 4,
  className,
}: {
  children: ReactNode;
  lines?: number;
  className?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const id = useId();
  // The folded height in px, once measured; null = never folds.
  const [foldHeight, setFoldHeight] = useState<number | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const lineHeight = parseFloat(window.getComputedStyle(el).lineHeight) || 24;
    // A little room, so one short extra line never gets a button.
    setFoldHeight(el.scrollHeight > lineHeight * (lines + 0.5) ? Math.round(lineHeight * lines) : null);
  }, [lines]);

  const foldable = foldHeight !== null;
  const folded = foldable && !open;
  return (
    <div className={className}>
      <div
        id={id}
        ref={contentRef}
        className={folded ? "relative overflow-hidden" : undefined}
        style={folded ? { maxHeight: `${foldHeight}px` } : undefined}
      >
        {children}
        {folded && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-surface to-transparent"
          />
        )}
      </div>
      {foldable && (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((v) => !v)}
          className="focus-ring mt-1.5 rounded-sm py-1 text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
        >
          {open ? "Lexo më pak" : "Lexo më shumë"}
        </button>
      )}
    </div>
  );
}

export function CoverZoom({
  src,
  alt,
  children,
}: {
  src: string;
  alt: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  return (
    <>
      <a
        href={src}
        aria-label="Shikoni ballinën të madhe"
        className="focus-ring block cursor-zoom-in rounded-[3px]"
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          dialogRef.current?.showModal();
        }}
      >
        {children}
      </a>
      <dialog
        ref={dialogRef}
        aria-label={alt}
        onClick={(event) => {
          // A click on the dark backdrop (the dialog itself) closes it.
          if (event.target === dialogRef.current) dialogRef.current?.close();
        }}
        className="m-auto max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] overflow-visible bg-transparent p-0 backdrop:bg-black/70"
      >
        <div className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt}
            className="block max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] object-contain"
          />
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label="Mbyll"
            className="focus-ring absolute top-2 right-2 flex size-10 items-center justify-center rounded-full bg-white/90 text-foreground hover:bg-white"
          >
            <IconClose className="size-5" />
          </button>
        </div>
      </dialog>
    </>
  );
}

export function ShareIconButton({
  url,
  title,
  className,
}: {
  url: string;
  title: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <>
      <button
        type="button"
        aria-label="Ndajeni librin"
        title="Ndajeni librin"
        className={className}
        onClick={() => {
          if (typeof navigator.share === "function") {
            // A cancelled share sheet rejects; nothing to report.
            navigator.share({ title, url }).catch(() => {});
            return;
          }
          if (!navigator.clipboard?.writeText) {
            setState("failed");
            return;
          }
          navigator.clipboard.writeText(url).then(
            () => setState("copied"),
            () => setState("failed"),
          );
        }}
      >
        <IconShare className="size-[0.9375rem] md:size-5" />
      </button>
      <span role="status" className="sr-only">
        {state === "copied" ? "U kopjua" : state === "failed" ? "Kopjojeni nga shiriti i adresës" : ""}
      </span>
      {state === "copied" && (
        <span aria-hidden="true" className="absolute top-full right-0 mt-1 rounded-[3px] bg-foreground px-2 py-0.5 text-xs whitespace-nowrap text-surface">
          U kopjua
        </span>
      )}
    </>
  );
}

export function TileStrip({ children }: { children: ReactNode }) {
  const listRef = useRef<HTMLDListElement>(null);
  // True once the browser has measured more tiles than fit.
  const [more, setMore] = useState(false);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const measure = () => setMore(el.scrollWidth > el.clientWidth + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  return (
    <div className="relative md:pr-10">
      <dl
        ref={listRef}
        data-detail-tiles=""
        className="flex snap-x overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </dl>
      {more && (
        <button
          type="button"
          aria-label="Më shumë të dhëna"
          onClick={() => {
            const el = listRef.current;
            if (!el) return;
            const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
            el.scrollTo({ left: atEnd ? 0 : el.scrollLeft + el.clientWidth, behavior: "smooth" });
          }}
          className="focus-ring absolute top-1/2 right-0 flex size-[1.875rem] -translate-y-1/2 items-center justify-center rounded-full border border-[#d9d3c3] bg-surface text-base text-foreground shadow-[0_2px_6px_rgba(0,0,0,0.1)] hover:bg-surface-hover max-md:hidden"
        >
          <span aria-hidden="true">›</span>
        </button>
      )}
    </div>
  );
}
