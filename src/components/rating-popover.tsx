"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { StarRating } from "@/components/star-rating";

// Amazon book page, patch 3 (items 3 + 21, design r7): the rating line
// under the title. "4,6 ★★★★★ ⌄" opens the star pop-up (the 5 -> 1 rows
// and "Shiko vlerësimet ›"); the count beside it ("128 vlerësime",
// "(128)" on phones) still jumps to the reviews block. Without
// JavaScript the count link works and the pop-up simply never opens.
// Closes with ✕, Escape, or a click outside; focus goes back to the
// button.
const GUTTER = 16;
const MAX_WIDTH = 360;

export function RatingPopover({
  ratingText,
  rating,
  countLong,
  countShort,
  children,
}: {
  ratingText: string;
  rating: number;
  countLong: string;
  countShort: string;
  /** The 5 -> 1 rows (server-rendered ReviewHistogram). */
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState<{ left: number; width: number }>({ left: 0, width: MAX_WIDTH });
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }, []);

  // Keep the pop-up inside the screen: on a phone it spans the page
  // width (16px each side), like the design's 390 picture.
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const place = () => {
      const left = wrapRef.current!.getBoundingClientRect().left;
      const viewport = document.documentElement.clientWidth;
      const width = Math.min(MAX_WIDTH, viewport - GUTTER * 2);
      const maxLeft = viewport - GUTTER - width - left;
      setOffset({ left: Math.min(0, Math.max(GUTTER - left, maxLeft)), width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close(true);
    };
    const onPointer = (event: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) close(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointer);
    };
  }, [open, close]);

  return (
    <div ref={wrapRef} data-rating-line="" className="relative mt-1 inline-flex min-h-11 items-center gap-2 text-sm whitespace-nowrap md:min-h-8">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${ratingText} nga 5 yje. Shikoni ndarjen e yjeve`}
        onClick={() => (open ? close(false) : setOpen(true))}
        className="focus-ring inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-sm md:min-h-8"
      >
        <span aria-hidden="true" className="font-semibold text-foreground">{ratingText}</span>
        <span aria-hidden="true"><StarRating rating={rating} /></span>
        <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 text-muted" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2.5 4.5 6 8l3.5-3.5" />
        </svg>
      </button>
      <a href="#vleresimet" className="focus-ring inline-flex min-h-11 items-center rounded-sm text-muted underline underline-offset-2 md:min-h-8">
        <span className="max-md:hidden">{countLong}</span>
        <span className="md:hidden">{countShort}</span>
      </a>

      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label="Ndarja e yjeve"
          data-rating-popover=""
          style={{ left: offset.left, width: offset.width }}
          className="absolute top-full z-30 mt-1 rounded-[8px] border border-[#d9d3c3] bg-surface px-[1.125rem] pt-[1.125rem] pb-3 whitespace-normal shadow-[0_6px_24px_rgba(0,0,0,0.18)]"
        >
          <button
            ref={closeRef}
            type="button"
            aria-label="Mbyll"
            onClick={() => close(true)}
            className="focus-ring absolute top-2 right-2.5 flex size-7 cursor-pointer items-center justify-center rounded-[6px] border border-border text-foreground hover:bg-[#efe9dd]"
          >
            <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
          <p className="flex items-center gap-2.5 pr-9 text-xl leading-7">
            <span className="text-[1.25rem]"><StarRating rating={rating} /></span>
            <b className="font-bold text-foreground">{`${ratingText} nga 5`}</b>
          </p>
          <p className="mt-0.5 text-sm text-muted">{countLong}</p>
          <div className="mt-3.5">{children}</div>
          <div className="mt-3.5 border-t border-border pt-2.5 text-center">
            <a
              href="#vleresimet"
              onClick={() => close(false)}
              className="focus-ring inline-flex min-h-8 items-center rounded-sm text-sm font-semibold text-primary hover:underline"
            >
              Shiko vlerësimet ›
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
