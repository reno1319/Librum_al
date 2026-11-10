"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { IconClose } from "@/components/icons";

// P1 book page (design B, 2026-11-10): the three small browser-side
// pieces of the new book page. Each one renders the plain, complete
// content on the server, so without JavaScript nothing is hidden:
// - ExpandableText: the full text; once the browser has measured it and
//   it is taller than `lines` lines, it folds and "Lexo më shumë" opens it.
// - CoverZoom: a link to the cover image itself; with JavaScript it opens
//   the large cover in a popup instead.
// - CopyLinkButton: a link to this book's page; with JavaScript it copies
//   that address instead.

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

export function CopyLinkButton({ path, className }: { path: string; className?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  return (
    <a
      href={path}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        const url = new URL(path, window.location.origin).toString();
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
      <span aria-live="polite">
        {state === "copied" ? "U kopjua" : state === "failed" ? "Kopjojeni nga shiriti i adresës" : "Kopjo lidhjen"}
      </span>
    </a>
  );
}
