"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";

// A Libraria shelf row (Renato 11-26, Kobo-style): one page of cards at
// a time, with arrows that slide the row one page sideways. The row
// itself is a normal sideways-scrolling list, so phones keep swiping it
// (the arrows show from sm up) and it still works with no JavaScript.
// Book page (Amazon page, item 23): `onPageChange` hears which page of
// the row shows ("Faqja 1 nga 3"); Libraria passes none.
export function ShelfSlider({
  label,
  children,
  onPageChange,
}: {
  label: string;
  children: ReactNode;
  onPageChange?: (scrollLeft: number, visibleWidth: number, scrollWidth: number) => void;
}) {
  const rowRef = useRef<HTMLUListElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(true);
  // The arrows sit level with the middle of the covers.
  const [arrowTop, setArrowTop] = useState<number | null>(null);

  const update = useCallback(() => {
    const row = rowRef.current;
    if (!row) return;
    setAtStart(row.scrollLeft <= 4);
    setAtEnd(row.scrollLeft + row.clientWidth >= row.scrollWidth - 4);
    const first = row.firstElementChild as HTMLElement | null;
    const paddingTop = parseFloat(getComputedStyle(row).paddingTop) || 0;
    if (first) setArrowTop(row.offsetTop + paddingTop + (first.offsetWidth * 8) / 5 / 2);
    if (onPageChange) {
      const style = getComputedStyle(row);
      const gap = parseFloat(style.columnGap) || 0;
      const inner = row.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      onPageChange(row.scrollLeft, inner + gap, row.scrollWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0) + gap);
    }
  }, [onPageChange]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    update();
    row.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(row);
    return () => {
      row.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [update]);

  // An arrow hides at its end of the row. If it had keyboard focus,
  // hand focus to the other arrow (or the row) so it isn't lost.
  useEffect(() => {
    const focused = document.activeElement;
    const lost = (atEnd && focused === nextRef.current) || (atStart && focused === backRef.current);
    if (!lost) return;
    const other = focused === nextRef.current ? (atStart ? null : backRef.current) : atEnd ? null : nextRef.current;
    (other ?? rowRef.current)?.focus();
  }, [atStart, atEnd]);

  // One page: the row's width inside its padding, plus one gap.
  const slide = (direction: 1 | -1) => {
    const row = rowRef.current;
    if (!row) return;
    const style = getComputedStyle(row);
    const page =
      row.clientWidth -
      (parseFloat(style.paddingLeft) || 0) -
      (parseFloat(style.paddingRight) || 0) +
      (parseFloat(style.columnGap) || 0);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    row.scrollBy({ left: direction * page, behavior: reduceMotion ? "auto" : "smooth" });
  };

  return (
    <div className="relative">
      <ul
        ref={rowRef}
        className="relative -mx-4 mt-3 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pt-2 pb-2 outline-none sm:-mx-2 sm:-mb-2 sm:scroll-px-2 sm:gap-6 sm:px-2 sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden"
        aria-label={label}
        tabIndex={-1}
      >
        {children}
      </ul>
      <SlideArrow ref={backRef} direction="back" hidden={atStart} top={arrowTop} onClick={() => slide(-1)} />
      <SlideArrow ref={nextRef} direction="next" hidden={atEnd} top={arrowTop} onClick={() => slide(1)} />
    </div>
  );
}

// One item of a ShelfSlider row: a phone shows about two and a half,
// then 3, 4 and 5 across per page.
export const SHELF_ITEM_CLASSES =
  "flex w-[42%] shrink-0 snap-start sm:w-[calc((100%-3rem)/3)] md:w-[calc((100%-4.5rem)/4)] lg:w-[calc((100%-6rem)/5)]";

// Kept in the page at the row's ends, just invisible and out of the
// tab order, so a focused arrow is never removed (audit N2).
function SlideArrow({
  ref,
  direction,
  hidden,
  top,
  onClick,
}: {
  ref: Ref<HTMLButtonElement>;
  direction: "back" | "next";
  hidden: boolean;
  top: number | null;
  onClick: () => void;
}) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      aria-label={direction === "back" ? "Librat e mëparshëm" : "Librat e tjerë"}
      aria-hidden={hidden || undefined}
      tabIndex={hidden ? -1 : undefined}
      style={top === null ? undefined : { top }}
      className={`focus-ring absolute top-1/3 z-10 hidden size-11 -translate-y-1/2 place-items-center rounded-full border border-border bg-white text-foreground shadow-[0_4px_12px_rgba(0,0,0,0.15)] transition-colors hover:bg-[#f3f1ec] sm:grid ${
        direction === "back" ? "-left-5" : "-right-5"
      } ${hidden ? "invisible" : ""}`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4">
        <path
          d={direction === "back" ? "M10 3 5 8l5 5" : "M6 3l5 5-5 5"}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
