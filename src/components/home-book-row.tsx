"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AdultTag } from "@/components/adult-tag";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";

// HOME-ROWS-1 (Renato 2026-11-12, design C2, then "one row" 1a-6a): the
// one sliding row of books in the homepage's "Botuar me Librum"
// section. A plain horizontal scroller with scroll-snap: swipe on phones
// (about 2½ covers visible, no arrows), ❮ ❯ buttons beside the section
// title from lg up (5 covers visible). No autoplay (4a). The
// buttons are real <button>s (keyboard and screen reader), hidden when
// the row does not overflow, and scroll instantly under reduced motion.
// Covers are plain <img> like every other cover on the site.

export type HomeRowBook = {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  isAdult: boolean;
  url: string;
  priceAll: number | null;
};

export function HomeBookRow({
  id,
  header,
  label,
  books,
  showPrice,
}: {
  id: string;
  // The section's own title and subtitle (2a: no row heading); the
  // buttons sit on their right.
  header: ReactNode;
  // The list's accessible name.
  label: string;
  books: HomeRowBook[];
  // Prices only while buying is on (design C2); decided by the page.
  showPrice: boolean;
}) {
  const scroller = useRef<HTMLUListElement>(null);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    // 1px slack: fractional widths can leave scrollLeft just short.
    setCanBack(el.scrollLeft > 1);
    setCanForward(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    update();
    el.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [update]);

  function page(direction: 1 | -1) {
    const el = scroller.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Most of one screenful, so the last cover seen stays in view.
    el.scrollBy({ left: direction * el.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  }

  const overflows = canBack || canForward;

  return (
    <>
      <div className="flex items-end justify-between gap-6">
        <div className="min-w-0">{header}</div>
        <div className={`hidden shrink-0 gap-2.5 ${overflows ? "lg:flex" : ""}`}>
          <ArrowButton direction="back" disabled={!canBack} onClick={() => page(-1)} controls={id} />
          <ArrowButton direction="forward" disabled={!canForward} onClick={() => page(1)} controls={id} />
        </div>
      </div>

      {/* Phones: the row runs to the screen edge (the page gutter is
          1rem), so the cut-off cover hints that it slides. `relative`
          keeps absolutely placed children (the 18+ tag's sr-only text)
          inside the scroller; without it they widen the whole page. */}
      <ul
        id={id}
        ref={scroller}
        aria-label={label}
        className="relative -mx-4 mt-8 flex snap-x snap-mandatory scroll-px-4 gap-4 overflow-x-auto px-4 pb-2 [scrollbar-width:none] sm:mx-0 sm:scroll-px-0 sm:px-0 lg:gap-6 [&::-webkit-scrollbar]:hidden"
      >
        {books.map((book) => (
          <li
            key={book.id}
            className="w-[38%] shrink-0 snap-start sm:w-[26%] md:w-[23%] lg:w-[calc((100%-6rem)/5)]"
          >
            <Link
              href={`/libra/${book.id}`}
              className="focus-ring group/book flex flex-col rounded-[3px]"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={book.url}
                alt=""
                loading="lazy"
                decoding="async"
                className="aspect-[5/8] w-full rounded-[3px] object-contain object-bottom drop-shadow-[0_6px_6px_rgba(0,0,0,0.25)] transition-transform duration-150 group-hover/book:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover/book:translate-y-0"
              />
              {(book.genre || book.isAdult) && (
                <p className="mt-3 flex flex-wrap items-center gap-x-2 text-xs font-semibold tracking-[0.08em] text-primary uppercase">
                  {book.genre && <span>{book.genre}</span>}
                  {book.isAdult && <AdultTag />}
                </p>
              )}
              <span lang="sq" className="mt-1 line-clamp-2 font-serif text-lg leading-snug text-primary group-hover/book:underline">
                {book.title}
              </span>
              {book.author && (
                <span lang="sq" className="mt-0.5 line-clamp-1 text-sm text-foreground/80">
                  {book.author}
                </span>
              )}
              {showPrice && book.priceAll != null && (
                <span className={`mt-1 text-sm font-bold ${book.priceAll === 0 ? "text-[#2f6b4f]" : "text-primary"}`}>
                  {formatCatalogPriceLabel(book.priceAll)}
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function ArrowButton({
  direction,
  disabled,
  onClick,
  controls,
}: {
  direction: "back" | "forward";
  disabled: boolean;
  onClick: () => void;
  controls: string;
}) {
  return (
    // aria-disabled, not disabled: a real disabled button drops keyboard
    // focus to <body> when the row reaches its end (audit M1). It stays
    // focusable, reads as unavailable, and a press does nothing.
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      aria-disabled={disabled}
      aria-controls={controls}
      aria-label={direction === "back" ? "Librat e mëparshëm" : "Librat e tjerë"}
      className="focus-ring grid size-11 place-items-center rounded-full border border-primary text-primary transition-colors hover:bg-primary hover:text-primary-foreground aria-disabled:cursor-default aria-disabled:border-border aria-disabled:text-muted aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted"
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={direction === "back" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}
