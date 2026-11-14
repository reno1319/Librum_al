import Link from "next/link";
import { Playfair_Display, Ultra } from "next/font/google";
import type { HomepageCta } from "@/lib/homepage";

// The KDP-style pieces shared by the author pages (K5 "Si funksionon",
// then "Fitimet", Renato 11-14): a big photo-filled hero letter, brace-shaped
// photos, soft waves between white and cream, orange dots, square-cornered
// buttons and a light closing band.

export const CREAM = "#fbf8f1";

export const GOLD_BUTTON =
  "focus-ring inline-flex min-h-12 shrink-0 items-center rounded-md bg-accent px-7 font-semibold text-accent-foreground hover:brightness-105";
export const OUTLINE_BUTTON =
  "focus-ring inline-flex min-h-12 items-center rounded-md border-2 border-primary px-7 font-semibold text-primary hover:bg-primary/5";

// The brace shape of the photos: rounded corners and a small point in the
// middle of each side, like a curly bracket. Drawn once per page, used by
// every Photo on it.
export function PhotoShapes() {
  return (
    <svg width="0" height="0" aria-hidden="true" className="absolute">
      <defs>
        <clipPath id="lb-brace" clipPathUnits="objectBoundingBox">
          <path d="M0.17,0 L0.83,0 C0.93,0 0.975,0.06 0.975,0.17 L0.975,0.43 C0.975,0.475 0.985,0.495 1,0.5 C0.985,0.505 0.975,0.525 0.975,0.57 L0.975,0.83 C0.975,0.94 0.93,1 0.83,1 L0.17,1 C0.07,1 0.025,0.94 0.025,0.83 L0.025,0.57 C0.025,0.525 0.015,0.505 0,0.5 C0.015,0.495 0.025,0.475 0.025,0.43 L0.025,0.17 C0.025,0.06 0.07,0 0.17,0 Z" />
        </clipPath>
      </defs>
    </svg>
  );
}

/** A decorative photo in the brace shape (needs <PhotoShapes /> on the page). */
export function Photo({ src, className = "" }: { src: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={`w-full object-cover [clip-path:url(#lb-brace)] ${className}`}
    />
  );
}

// The hero letter: one big character from a real typeface (Playfair
// Display Italic Black, his pick b on K5), filled with a photo, like the
// KDP "A" and "&".
const letterFont = Playfair_Display({ weight: "900", style: "italic", subsets: ["latin"], display: "swap" });
// Ultra (his pick d on Fitimet): the Playfair "%" has thin strokes, so the
// photo hardly showed; this heavy serif lets it show through.
const heavyFont = Ultra({ weight: "400", subsets: ["latin"], display: "swap" });

export function HeroLetter({ char, src, heavy = false }: { char: string; src: string; heavy?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`${heavy ? heavyFont.className : letterFont.className} block select-none whitespace-nowrap text-right leading-[1.02] text-transparent [-webkit-background-clip:text] [background-clip:text] [font-size:clamp(15rem,40vw,36rem)]`}
      style={{
        backgroundImage: `url(${src})`,
        backgroundSize: "cover",
        backgroundPosition: "center 30%",
      }}
    >
      {char}
    </span>
  );
}

// A soft wave where a white section meets a cream one.
export function Wave({ flip = false }: { flip?: boolean }) {
  return (
    <svg
      viewBox="0 0 1440 60"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={`block h-8 w-full bg-white md:h-14 ${flip ? "rotate-180" : ""}`}
    >
      <path d="M0 40 C 360 0, 1080 70, 1440 22 L1440 60 L0 60 Z" fill={CREAM} />
    </svg>
  );
}

export function Dot() {
  return <span aria-hidden="true" className="mt-[0.55em] block size-2.5 shrink-0 rounded-full bg-[#d98e5f]" />;
}

export function Bullets({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="mt-5 flex flex-col gap-4">
      {items.map((item, i) => (
        <li key={i} className="flex gap-4 text-base leading-relaxed text-foreground/90 md:text-[1.0625rem]">
          <Dot />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// The light closing band, heading and button side by side ("ju", his pick).
export function LightClosingBand({ cta }: { cta: HomepageCta }) {
  return (
    <section className="bg-[#eceae4]">
      <div className="page-container flex flex-col items-center justify-center gap-5 py-10 text-center md:flex-row md:gap-10 md:py-12 md:text-left">
        <div>
          <h2 className="font-serif text-3xl font-normal text-primary sm:text-[2.25rem]">A jeni gati të botoni?</h2>
          <p className="mt-2 text-foreground/80">
            Krijoni librin tuaj të parë në Librum dhe botojeni sipas kushteve tuaja.
          </p>
        </div>
        <Link href={cta.href} className={GOLD_BUTTON}>
          {cta.label}
        </Link>
      </div>
    </section>
  );
}
