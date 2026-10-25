import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { fitVertical, fitWrappedPx, type VerticalOptions } from "@/lib/ornate-shelf-fit";

// BOOKSTORE ORNATE SHELF (Renato 10-25, boards "Option 1, refined
// (latest)" and "Bookstore header B"): five real books drawn as
// leather-bound spines on a short wooden shelf. Each shelf slot has its
// own fixed width, height and binding (74/108/58/92/62px wide); the
// bindings cycle by position, so the newest book always gets the first
// one. Every title runs along its spine, bottom to top (SHELF-2); on
// spines under ~65px wide the author follows it, on wider ones the
// author stays across the foot.
//
// The ornaments are Librum's own drawings (lattice, jewel band, shield
// and star, swashes, sprig). They are not copied from any
// publisher's binding; keep them original if they are ever redrawn.
//
// Sizes here are the board's own, at full scale. The page scales the
// whole shelf with CSS zoom (the Bookstore uses 70%), so every size
// below stays in proportion. Everything except the titles and authors
// is decorative and hidden from assistive technology; each spine is one
// link with the same accessible name as the home page's spines.

export const ORNATE_SHELF_SIZE = 5;

export type OrnateShelfBook = { id: string; title: string; author: string | null };

const GOLD_TEXT = "#ecd27a";
const GOLD = "url(#ornate-shelf-gold)";
const GOLD_ACROSS = "url(#ornate-shelf-gold-across)";
// A flat mid-gold for single straight rules: a gradient in the default
// objectBoundingBox units paints nothing on a perfectly straight line,
// because its box has zero height (SVG spec; SHELF-1 audit N1).
const GOLD_RULE = "#d9b44a";
const SERIF = "var(--font-serif), Georgia, serif";
const TEXT_SHADOW = "0 1px 0 rgba(0,0,0,.6)";

// The shared gradients and textures, defined once per shelf. The ids are
// fixed, so a page shows at most one ornate shelf.
function OrnamentDefs() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="ornate-shelf-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f8e7a6" />
          <stop offset="0.4" stopColor="#d9b44a" />
          <stop offset="0.75" stopColor="#a87f26" />
          <stop offset="1" stopColor="#e2c46a" />
        </linearGradient>
        <linearGradient id="ornate-shelf-gold-across" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#8f6b1f" />
          <stop offset="0.5" stopColor="#f8e7a6" />
          <stop offset="1" stopColor="#8f6b1f" />
        </linearGradient>
        <filter id="ornate-shelf-leather" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={3} seed={7} />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <filter id="ornate-shelf-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.012 0.6" numOctaves={3} seed={3} />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
    </svg>
  );
}

// Leather grain over the whole spine, then the curved-spine light on
// top: dark edges, a soft highlight left of centre.
function Leather({ opacity }: { opacity: number }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="pointer-events-none absolute inset-0 size-full mix-blend-multiply"
      style={{ opacity }}
    >
      <rect width="100%" height="100%" filter="url(#ornate-shelf-leather)" />
    </svg>
  );
}

function SpineLight({ edge, highlight }: { edge: number; highlight: number }) {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      style={{
        background: `linear-gradient(90deg, rgba(0,0,0,${edge}), rgba(0,0,0,.08) 15%, rgba(255,255,255,${highlight}) 35%, rgba(255,255,255,0) 55%, rgba(0,0,0,.14) 80%, rgba(0,0,0,${edge + 0.05}))`,
      }}
    />
  );
}

// A raised band across the spine, like the ridge over a sewn cord.
function RaisedBand({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`h-[7px] w-full shrink-0 border-y border-[#b8913a] ${className}`}
      style={{ background: "linear-gradient(180deg, rgba(0,0,0,.4), rgba(255,255,255,.22) 45%, rgba(0,0,0,.45))" }}
    />
  );
}

// Wrapped title or author text: the longest word fits the box, then
// whole words wrap; a word the estimate misses is hyphenated or broken.
function WrappedText({
  text,
  lines,
  style,
}: {
  text: string;
  lines: number;
  style: CSSProperties;
}) {
  return (
    <span
      lang="sq"
      className="block overflow-hidden text-center hyphens-auto [overflow-wrap:anywhere]"
      style={{
        display: "-webkit-box",
        WebkitBoxOrient: "vertical",
        WebkitLineClamp: lines,
        fontFamily: SERIF,
        ...style,
      }}
    >
      {text}
    </span>
  );
}

// SHELF-2 (Renato 10-25, 1a 2a): every title runs along its spine,
// bottom to top, so a word is never cut in the middle. A long title
// takes a second (or third) line beside the first and only then gets
// smaller; type may go small rather than cut the title. On the thin
// spines the author follows the title on the same line of sight, as
// before; on the wide ones the author stays across the foot.
const SIDEWAYS_AUTHOR = { emPerChar: 0.9, maxPx: 10, minPx: 7 };
function AlongSpine({
  book,
  options,
  color,
  shadow,
  titleStyle,
  withAuthor,
}: {
  book: OrnateShelfBook;
  options: VerticalOptions;
  color: string;
  shadow?: string;
  titleStyle?: CSSProperties;
  withAuthor: boolean;
}) {
  const author = withAuthor ? book.author : null;
  const fit = fitVertical(book.title, author, options);
  return (
    <div
      className="flex min-h-0 w-full flex-1 items-center justify-center overflow-hidden whitespace-nowrap"
      style={{
        writingMode: "vertical-rl",
        transform: "rotate(180deg)",
        gap: options.gapPx,
        fontFamily: SERIF,
        color,
        textShadow: shadow,
      }}
    >
      <span
        lang="sq"
        className="min-h-0 shrink overflow-hidden"
        style={{ fontSize: fit.titlePx, lineHeight: options.lineHeight, letterSpacing: "0.02em", ...titleStyle }}
      >
        {fit.titleLines.map((line, i) => (
          <span key={i} className="block overflow-hidden text-ellipsis">
            {line}
          </span>
        ))}
      </span>
      {author && (
        <span
          lang="sq"
          className="min-h-0 shrink-0 overflow-hidden text-ellipsis uppercase"
          style={{ fontSize: fit.authorPx, letterSpacing: "0.14em", maxHeight: `${(options.authorShare ?? 0.4) * 100}%` }}
        >
          {author}
        </span>
      )}
    </div>
  );
}

// ---- Binding 1: oxblood, 74px. A gilt eye, the title up the spine in
// a double frame, the author between rules, a wave at the foot.
export const OXBLOOD_TITLE: VerticalOptions = {
  lengthPx: 220,
  widthPx: 50,
  gapPx: 0,
  lineHeight: 1.15,
  maxLines: 3,
  title: { emPerChar: 0.76, maxPx: 14, minPx: 6, caps: true },
};
function OxbloodSpine({ book }: { book: OrnateShelfBook }) {
  return (
    <div className="relative flex h-full flex-col items-center gap-[9px] pt-[9px] pb-2">
      <svg viewBox="0 0 74 30" width="74" height="30" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M7 2 H67 M7 28 H67" stroke={GOLD_ACROSS} strokeWidth="1.4" />
        <path d="M37 6 C28 6 26 15 17 15 C26 15 28 24 37 24 C46 24 48 15 57 15 C48 15 46 6 37 6 Z" fill="none" stroke={GOLD} strokeWidth="1.4" />
        <circle cx="37" cy="15" r="3.2" fill={GOLD} />
        <circle cx="11" cy="15" r="1.8" fill={GOLD} />
        <circle cx="63" cy="15" r="1.8" fill={GOLD} />
      </svg>
      <RaisedBand />
      <div className="flex min-h-0 w-16 flex-1 flex-col border-[3px] border-double border-[#c9a54a] px-0.5 py-2">
        <AlongSpine
          book={book}
          options={OXBLOOD_TITLE}
          withAuthor={false}
          color={GOLD_TEXT}
          shadow={TEXT_SHADOW}
          titleStyle={{ textTransform: "uppercase" }}
        />
      </div>
      <RaisedBand />
      {book.author && (
        <div className="w-full shrink-0 px-[5px]">
          <WrappedText
            text={book.author}
            lines={2}
            style={{
              fontSize: fitWrappedPx(book.author, { boxPx: 62, emPerChar: 0.86, maxPx: 9.5, minPx: 7, lines: 2 }),
              lineHeight: 1.3,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: GOLD_TEXT,
              textShadow: TEXT_SHADOW,
            }}
          />
        </div>
      )}
      <svg viewBox="0 0 74 18" width="74" height="18" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M7 2 H67 M7 16 H67" stroke={GOLD_ACROSS} strokeWidth="1.2" />
        <path d="M12 9 Q18 4 24 9 T37 9 T50 9 T63 9" stroke={GOLD} strokeWidth="1.2" fill="none" />
      </svg>
    </div>
  );
}

// ---- Binding 2: navy with red studs, 108px. A shield and star, the
// title up the spine in a framed panel between swashes, the author in
// a small panel at the foot.
const NAVY = "#1c3564";
const NAVY_PANEL_RING = "0 0 0 1px rgba(201,165,74,.55)";
export const NAVY_TITLE: VerticalOptions = {
  lengthPx: 215,
  widthPx: 84,
  gapPx: 0,
  lineHeight: 1.05,
  maxLines: 3,
  title: { emPerChar: 0.8, maxPx: 20, minPx: 7, caps: true },
};
function NavySpine({ book }: { book: OrnateShelfBook }) {
  return (
    <div className="relative flex h-full flex-col items-center gap-2 pt-3 pb-2.5">
      <svg viewBox="0 0 108 70" width="108" height="70" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M20 30 C10 26 10 14 20 12 M88 30 C98 26 98 14 88 12" stroke={GOLD} strokeWidth="1.5" fill="none" />
        <path d="M38 6 H70 V32 C70 47 54 56 54 56 C54 56 38 47 38 32 Z" fill="#9b2c2c" stroke={GOLD} strokeWidth="2.4" />
        <path d="M54 15 L57 25 L67 25 L59 31 L62 41 L54 35 L46 41 L49 31 L41 25 L51 25 Z" fill={GOLD} />
        <path d="M14 66 H94" stroke={GOLD_RULE} strokeWidth="1.6" />
      </svg>
      <div
        className="flex min-h-0 w-24 flex-1 flex-col items-center gap-1.5 px-1.5 py-1.5"
        style={{ background: NAVY, boxShadow: NAVY_PANEL_RING }}
      >
        <svg viewBox="0 0 96 16" width="90" height="16" aria-hidden="true" focusable="false" className="shrink-0">
          <path d="M6 14 C18 2 34 2 48 10 C62 2 78 2 90 14" stroke={GOLD} strokeWidth="1.4" fill="none" />
          <circle cx="48" cy="10" r="2.6" fill={GOLD} />
        </svg>
        <AlongSpine
          book={book}
          options={NAVY_TITLE}
          withAuthor={false}
          color={GOLD_TEXT}
          shadow="0 1px 0 rgba(0,0,0,.65)"
          titleStyle={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}
        />
        <svg viewBox="0 0 96 16" width="90" height="16" aria-hidden="true" focusable="false" className="shrink-0">
          <path d="M6 2 C18 14 34 14 48 6 C62 14 78 14 90 2" stroke={GOLD} strokeWidth="1.4" fill="none" />
          <circle cx="48" cy="6" r="2.6" fill={GOLD} />
        </svg>
      </div>
      {book.author && (
        <div className="max-w-24 shrink-0 px-1.5 py-[3px]" style={{ background: NAVY }}>
          <WrappedText
            text={book.author}
            lines={2}
            style={{
              fontSize: fitWrappedPx(book.author, { boxPx: 84, emPerChar: 0.55, maxPx: 12.5, minPx: 8, lines: 2 }),
              fontStyle: "italic",
              lineHeight: 1.2,
              color: GOLD_TEXT,
              textShadow: TEXT_SHADOW,
            }}
          />
        </div>
      )}
      <svg viewBox="0 0 108 16" width="108" height="16" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M10 2 H98 M10 14 H98" stroke={GOLD_ACROSS} strokeWidth="1.3" />
        <path d="M16 8 H92" stroke={GOLD_RULE} strokeWidth="1" strokeDasharray="2 4" />
      </svg>
    </div>
  );
}

// ---- Binding 3: sky blue, 58px. Zigzag bands in white, a gilt
// eight-point star; title and author along the spine.
export const SKY_ALONG: VerticalOptions = {
  lengthPx: 255,
  widthPx: 48,
  gapPx: 12,
  lineHeight: 1.1,
  maxLines: 2,
  title: { emPerChar: 0.52, maxPx: 16, minPx: 7 },
  author: SIDEWAYS_AUTHOR,
  authorShare: 0.4,
};
function SkySpine({ book }: { book: OrnateShelfBook }) {
  return (
    <div className="relative flex h-full flex-col items-center gap-2.5 pt-[9px] pb-2">
      <svg viewBox="0 0 58 24" width="58" height="24" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M5 2 H53 M5 22 H53" stroke="#e9f1f8" strokeWidth="1.2" />
        <path d="M5 8 L10 16 L15 8 L20 16 L25 8 L29 16 L33 8 L38 16 L43 8 L48 16 L53 8" stroke="#e9f1f8" strokeWidth="1.1" fill="none" />
      </svg>
      <svg viewBox="0 0 30 30" width="26" height="26" aria-hidden="true" focusable="false" className="shrink-0">
        <g stroke={GOLD} strokeWidth="1.6" strokeLinecap="round">
          <path d="M15 3 V27 M3 15 H27 M6.5 6.5 L23.5 23.5 M23.5 6.5 L6.5 23.5" />
        </g>
        <circle cx="15" cy="15" r="2.6" fill={GOLD} />
      </svg>
      <AlongSpine book={book} options={SKY_ALONG} withAuthor color="#f4f8fb" shadow="0 1px 0 rgba(0,0,0,.45)" />
      <svg viewBox="0 0 58 22" width="58" height="22" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M5 2 H53 M5 20 H53" stroke="#e9f1f8" strokeWidth="1.2" />
        <path d="M5 15 L10 7 L15 15 L20 7 L25 15 L29 7 L33 15 L38 7 L43 15 L48 7 L53 15" stroke="#e9f1f8" strokeWidth="1.1" fill="none" />
      </svg>
    </div>
  );
}

// ---- Binding 4: cream, 92px. A jewel band, the title up the spine in
// red between gilt rules, the author across, a red-and-blue studded
// lattice at the foot.
const CREAM_RED = "#9a2229";
const LATTICE_LINES =
  "repeating-linear-gradient(45deg, transparent 0 10.5px, rgba(176,138,40,.75) 10.5px 11.5px), repeating-linear-gradient(-45deg, transparent 0 10.5px, rgba(176,138,40,.75) 10.5px 11.5px)";
export const CREAM_TITLE: VerticalOptions = {
  lengthPx: 170,
  widthPx: 76,
  gapPx: 0,
  lineHeight: 1.12,
  maxLines: 3,
  title: { emPerChar: 0.56, maxPx: 18, minPx: 7 },
};
function CreamSpine({ book }: { book: OrnateShelfBook }) {
  return (
    <div className="relative flex h-full flex-col items-center gap-[9px] pt-2.5 pb-[9px]">
      <svg viewBox="0 0 92 30" width="92" height="30" aria-hidden="true" focusable="false" className="shrink-0">
        <rect x="5" y="2" width="82" height="26" rx="2" fill="none" stroke={GOLD} strokeWidth="1.8" />
        <rect x="6" y="12" width="80" height="6" fill="#a8282f" />
        <circle cx="46" cy="15" r="7" fill="#a8282f" stroke={GOLD} strokeWidth="1.8" />
        <circle cx="23" cy="15" r="5" fill="#2a5aa0" stroke={GOLD} strokeWidth="1.8" />
        <circle cx="69" cy="15" r="5" fill="#2a5aa0" stroke={GOLD} strokeWidth="1.8" />
      </svg>
      <svg viewBox="0 0 92 16" width="92" height="16" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M8 8 H84" stroke={GOLD_RULE} strokeWidth="1.6" />
        <path d="M36 8 Q46 -1 56 8 Q46 17 36 8 Z" fill={GOLD} />
      </svg>
      <div className="flex min-h-0 w-20 flex-1 flex-col">
        <AlongSpine book={book} options={CREAM_TITLE} withAuthor={false} color={CREAM_RED} />
      </div>
      <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M6 0 L7.2 4.8 L12 6 L7.2 7.2 L6 12 L4.8 7.2 L0 6 L4.8 4.8 Z" fill="#2a5aa0" />
      </svg>
      {book.author && (
        <div className="w-20 shrink-0">
          <WrappedText
            text={book.author}
            lines={2}
            style={{
              fontSize: fitWrappedPx(book.author, { boxPx: 80, emPerChar: 0.86, maxPx: 10, minPx: 7, lines: 2 }),
              lineHeight: 1.3,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              color: CREAM_RED,
            }}
          />
        </div>
      )}
      <svg viewBox="0 0 92 16" width="92" height="16" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M8 8 H84" stroke={GOLD_RULE} strokeWidth="1.6" />
        <circle cx="46" cy="8" r="3" fill={GOLD} />
      </svg>
      <div
        aria-hidden="true"
        className="h-12 w-20 shrink-0"
        style={{ background: `radial-gradient(circle, #a8282f 1.8px, transparent 2.2px) 0 0 / 16px 16px, ${LATTICE_LINES}` }}
      />
      <svg viewBox="0 0 92 22" width="92" height="22" aria-hidden="true" focusable="false" className="shrink-0">
        <rect x="5" y="2" width="82" height="18" fill="#2a5aa0" stroke={GOLD} strokeWidth="1.8" />
        <path d="M6 11 H86" stroke="#a8282f" strokeWidth="3.5" />
        <circle cx="46" cy="11" r="4.5" fill={GOLD} />
      </svg>
    </div>
  );
}

// ---- Binding 5: forest green, 62px. A gilt knot at the head, a sprig
// at the foot; title (italic) and author along the spine.
export const GREEN_ALONG: VerticalOptions = {
  lengthPx: 224,
  widthPx: 52,
  gapPx: 12,
  lineHeight: 1.1,
  maxLines: 2,
  title: { emPerChar: 0.5, maxPx: 17, minPx: 7 },
  author: SIDEWAYS_AUTHOR,
  authorShare: 0.4,
};
function GreenSpine({ book }: { book: OrnateShelfBook }) {
  return (
    <div className="relative flex h-full flex-col items-center gap-[9px] pt-[9px] pb-2">
      <svg viewBox="0 0 62 40" width="62" height="40" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M5 2 H57" stroke={GOLD_RULE} strokeWidth="1.4" />
        <path d="M31 8 C23 8 23 20 31 20 C39 20 39 8 31 8 Z M31 20 C26 25 16 25 11 33 M31 20 C36 25 46 25 51 33" stroke={GOLD} strokeWidth="1.3" fill="none" />
        <circle cx="31" cy="14" r="2.4" fill={GOLD} />
        <path d="M5 38 H57" stroke={GOLD_RULE} strokeWidth="1.4" />
      </svg>
      <RaisedBand />
      <AlongSpine book={book} options={GREEN_ALONG} withAuthor color={GOLD_TEXT} shadow={TEXT_SHADOW} titleStyle={{ fontStyle: "italic" }} />
      <RaisedBand />
      <svg viewBox="0 0 30 44" width="22" height="34" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M15 42 C16 30 14 18 15 2" stroke={GOLD} strokeWidth="1.3" fill="none" />
        <g fill={GOLD}>
          <ellipse cx="10" cy="12" rx="5" ry="2.2" transform="rotate(-30 10 12)" />
          <ellipse cx="20" cy="20" rx="5" ry="2.2" transform="rotate(30 20 20)" />
          <ellipse cx="10" cy="28" rx="5" ry="2.2" transform="rotate(-30 10 28)" />
        </g>
      </svg>
      <svg viewBox="0 0 62 14" width="62" height="14" aria-hidden="true" focusable="false" className="shrink-0">
        <path d="M5 2 H57 M5 12 H57" stroke={GOLD_ACROSS} strokeWidth="1.2" />
      </svg>
    </div>
  );
}

type Binding = {
  width: number;
  height: number;
  background: string;
  radius: string;
  leather: number;
  edge: number;
  highlight: number;
  Content: (props: { book: OrnateShelfBook }) => ReactNode;
};

// The five shelf slots, left to right. Text pairs on every binding are
// at least 4.5:1 (gold #ecd27a on oxblood/navy/green, near-white on sky
// blue, red #9a2229 on cream).
export const ORNATE_BINDINGS: readonly Binding[] = [
  { width: 74, height: 400, background: "#651c22", radius: "5px 5px 1px 1px / 4px 4px 1px 1px", leather: 0.22, edge: 0.5, highlight: 0.16, Content: OxbloodSpine },
  {
    width: 108,
    height: 452,
    background: `radial-gradient(circle, #a83a3a 1.2px, transparent 1.6px) 4px 4px / 12px 12px, ${NAVY}`,
    radius: "6px 6px 1px 1px / 4px 4px 1px 1px",
    leather: 0.22,
    edge: 0.5,
    highlight: 0.14,
    Content: NavySpine,
  },
  { width: 58, height: 384, background: "#3d74a3", radius: "5px 5px 1px 1px / 4px 4px 1px 1px", leather: 0.2, edge: 0.45, highlight: 0.18, Content: SkySpine },
  { width: 92, height: 432, background: "#efe5cf", radius: "6px 6px 1px 1px / 4px 4px 1px 1px", leather: 0.12, edge: 0.28, highlight: 0.35, Content: CreamSpine },
  { width: 62, height: 396, background: "#2a4739", radius: "5px 5px 1px 1px / 4px 4px 1px 1px", leather: 0.25, edge: 0.5, highlight: 0.13, Content: GreenSpine },
];

export function OrnateShelf({ books, label }: { books: OrnateShelfBook[]; label: string }) {
  const shown = books.slice(0, ORNATE_SHELF_SIZE);
  if (shown.length === 0) return null;

  return (
    <div className="relative inline-flex flex-col">
      <OrnamentDefs />
      <ul
        aria-label={label}
        className="flex items-end gap-0.5 px-[22px] [filter:drop-shadow(14px_2px_12px_rgba(0,0,0,0.45))]"
      >
        {shown.map((book, i) => {
          const binding = ORNATE_BINDINGS[i % ORNATE_BINDINGS.length];
          const { Content } = binding;
          return (
            <li key={book.id} className="flex">
              <Link
                href={`/books/${book.id}`}
                aria-label={`View ${book.title} on Librum`}
                className="focus-ring relative block overflow-hidden no-underline transition-transform duration-150 hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
                style={{
                  width: binding.width,
                  height: binding.height,
                  borderRadius: binding.radius,
                  background: binding.background,
                }}
              >
                <Leather opacity={binding.leather} />
                <Content book={book} />
                <SpineLight edge={binding.edge} highlight={binding.highlight} />
              </Link>
            </li>
          );
        })}
      </ul>
      {/* The wooden shelf, only as wide as the books (plus a small lip
          each side): a lit top face, then the grained front edge. */}
      <div aria-hidden="true">
        <div
          className="h-2.5 shadow-[inset_0_3px_4px_rgba(0,0,0,0.35)]"
          style={{ background: "linear-gradient(180deg, #a07a46, #8a6838)" }}
        />
        <div
          className="relative h-5 overflow-hidden rounded-b-[2px] shadow-[0_12px_18px_rgba(0,0,0,0.45),0_3px_4px_rgba(0,0,0,0.35)]"
          style={{ background: "linear-gradient(180deg, #7a5a30, #5e4322)" }}
        >
          <svg aria-hidden="true" focusable="false" className="absolute inset-0 size-full opacity-35 mix-blend-multiply">
            <rect width="100%" height="100%" filter="url(#ornate-shelf-grain)" />
          </svg>
          <div className="absolute inset-x-0 top-0 h-px bg-[rgba(255,230,180,0.35)]" />
        </div>
      </div>
    </div>
  );
}
