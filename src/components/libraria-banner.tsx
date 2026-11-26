"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { SLIDE_ROTATE_MS } from "@/lib/libraria-banner";

// LR1 patch 3 (Renato 2026-11-25): the banner at the top of Libraria.
// Each slide is the staff picture (a taller phone picture when staff
// gave one, else the wide one's middle, lr3-9 b) with the book's cover,
// the tag staff typed (lr3-2 b, none when empty), the book's own title
// (lr3-1 a), "nga <author>", the one-line description and "Shiko
// librin"; the whole slide opens the book page.
// lr3-3 a: slides change by themselves every 6 seconds; a hover or a
// keyboard focus pauses them, and a tap on an arrow or a dot, or a
// swipe, stops them. Dots show which slide; phones swipe. Readers who
// turn motion off get no movement at all. With one slide there are no
// arrows or dots.

export type BannerSlide = {
  id: string;
  href: string;
  title: string;
  author: string | null;
  description: string;
  tag: string | null;
  pictureUrl: string;
  phonePictureUrl: string | null;
  coverUrl: string | null;
};

const SWIPE_PX = 40;

export function LibrariaBanner({ slides }: { slides: BannerSlide[] }) {
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(true);
  const startX = useRef<number | null>(null);
  // A swipe must not also open the book page.
  const swiped = useRef(false);
  const count = slides.length;

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduceMotion(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (count < 2 || paused || stopped || reduceMotion) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), SLIDE_ROTATE_MS);
    return () => window.clearInterval(timer);
  }, [count, paused, stopped, reduceMotion]);

  const go = useCallback(
    (next: number) => {
      setStopped(true);
      setIndex(((next % count) + count) % count);
    },
    [count],
  );

  if (count === 0) return null;

  return (
    <section
      aria-roledescription="carousel"
      aria-label="Të veçuara në Librum"
      className="relative"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaused(false);
      }}
    >
      <div
        className="touch-pan-y overflow-hidden rounded-[12px]"
        onPointerDown={(e) => {
          startX.current = e.clientX;
          swiped.current = false;
        }}
        onClickCapture={(e) => {
          if (swiped.current) {
            e.preventDefault();
            swiped.current = false;
          }
        }}
        onPointerUp={(e) => {
          if (startX.current === null || count < 2) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (Math.abs(dx) >= SWIPE_PX) {
            swiped.current = true;
            go(index + (dx < 0 ? 1 : -1));
          }
        }}
      >
        <ul
          className={`flex ${reduceMotion ? "" : "transition-transform duration-500 ease-out"}`}
          style={{ transform: `translateX(-${index * 100}%)` }}
        >
          {slides.map((slide, i) => (
            <li
              key={slide.id}
              role="group"
              aria-roledescription="slide"
              aria-label={`${i + 1} nga ${count}`}
              aria-hidden={i !== index}
              inert={i !== index}
              className="w-full shrink-0"
            >
              <Slide slide={slide} eager={i === 0} />
            </li>
          ))}
        </ul>
      </div>

      {count > 1 && (
        <>
          <Arrow direction="back" onClick={() => go(index - 1)} />
          <Arrow direction="forward" onClick={() => go(index + 1)} />
          <div className="mt-3 flex justify-center gap-1">
            {slides.map((slide, i) => (
              <button
                key={slide.id}
                type="button"
                onClick={() => go(i)}
                aria-label={`Shko te slajdi ${i + 1}`}
                aria-current={i === index ? "true" : undefined}
                className="focus-ring grid size-6 place-items-center rounded-full"
              >
                <span
                  className={`block h-2 rounded-full transition-all motion-reduce:transition-none ${
                    i === index ? "w-6 bg-primary" : "w-2 bg-border"
                  }`}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Slide({ slide, eager }: { slide: BannerSlide; eager: boolean }) {
  return (
    <Link
      href={slide.href}
      draggable={false}
      className="focus-ring group relative flex h-[340px] items-end overflow-hidden rounded-[12px] bg-primary sm:h-[300px] sm:items-center lg:h-[320px]"
    >
      <picture>
        {slide.phonePictureUrl && <source media="(max-width: 639px)" srcSet={slide.phonePictureUrl} />}
        <img
          src={slide.pictureUrl}
          alt=""
          draggable={false}
          loading={eager ? "eager" : "lazy"}
          decoding="async"
          className="absolute inset-0 size-full object-cover object-center"
        />
      </picture>
      {/* Keeps the words readable on any picture: dark from the bottom on
          phones, from the left from sm up. */}
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent sm:bg-gradient-to-r sm:from-black/75 sm:via-black/40"
      />
      <div className="relative flex w-full items-end gap-4 p-4 sm:items-center sm:gap-7 sm:px-16 sm:py-8">
        <div className="w-[74px] shrink-0 sm:w-[132px] lg:w-[150px]">
          {slide.coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={slide.coverUrl}
              alt=""
              draggable={false}
              loading={eager ? "eager" : "lazy"}
              decoding="async"
              className="aspect-[5/8] w-full rounded-[2px] object-contain object-bottom drop-shadow-[0_6px_10px_rgba(0,0,0,0.45)]"
            />
          ) : (
            <CoverPlaceholder
              title={slide.title}
              authorName={slide.author}
              className="aspect-[5/8] w-full rounded-[2px] shadow-[0_6px_10px_rgba(0,0,0,0.45)]"
            />
          )}
        </div>
        <div lang="sq" className="min-w-0 max-w-xl text-white">
          {slide.tag && (
            <span className="inline-block rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-accent-foreground">
              {slide.tag}
            </span>
          )}
          <p className="mt-2 line-clamp-2 font-serif text-2xl leading-tight sm:text-[2rem]">{slide.title}</p>
          {slide.author && <p className="mt-1 text-sm text-white/85">nga {slide.author}</p>}
          <p className="mt-2 line-clamp-2 text-sm text-white/90 sm:text-base">{slide.description}</p>
          <span className="mt-3 inline-flex min-h-10 items-center rounded-full bg-white px-4 text-sm font-semibold text-primary group-hover:bg-accent group-hover:text-accent-foreground">
            Shiko librin
          </span>
        </div>
      </div>
    </Link>
  );
}

function Arrow({ direction, onClick }: { direction: "back" | "forward"; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={direction === "back" ? "Slajdi i mëparshëm" : "Slajdi tjetër"}
      className={`focus-ring absolute top-[150px] hidden size-10 -translate-y-1/2 place-items-center rounded-full bg-white/90 text-primary shadow-md transition-colors hover:bg-white sm:grid lg:top-[160px] ${
        direction === "back" ? "left-3" : "right-3"
      }`}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d={direction === "back" ? "M15 18l-6-6 6-6" : "M9 6l6 6-6 6"} />
      </svg>
    </button>
  );
}
