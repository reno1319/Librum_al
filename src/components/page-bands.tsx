import Link from "next/link";
import type { ReactNode } from "react";
import type { HomepageCta } from "@/lib/homepage";

// AUTHOR PAGES REDESIGN: the home page's A2 pieces, shared so the inner
// author pages (About, How it works, Earnings, Help, Terms, Privacy) use
// the same classes instead of copies. No new colours, fonts or radii:
// every class here was on the home page before it moved.

// Brass call-to-action button (square-cornered, like the mockup) for the
// green bands: brass fill with green text (5.85:1), cream fill on hover
// (11.1:1).
export const BRASS_CTA_CLASSES =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-[3px] bg-accent px-7 py-4 text-base font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground";

// Underlined at rest, thicker underline on hover (C1).
export const TEXT_LINK_CLASSES =
  "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";

// REDESIGN STEP 2: the A2 mockup's section frame -- a wide container,
// generous vertical rhythm and left-aligned regular-weight serif
// headings in green.
export const SECTION_CONTAINER = "page-container py-12 md:py-16";
export const SECTION_HEADING = "font-serif text-3xl font-normal text-primary sm:text-4xl lg:text-[2.625rem]";
// Italic dark-brass numerals, as in the mockup (4.43:1 on cream and
// white; large text, so 3:1 applies).
export const NUMERAL_CLASSES = "block font-serif text-[1.75rem] italic leading-none text-[#8a6d12]";

// The brass rule and uppercase brass line above a heading on a green band.
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span aria-hidden="true" className="block h-px w-10 bg-accent" />
      <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-accent">{children}</p>
    </div>
  );
}

// The short dark-green header band of an inner page: eyebrow, serif h1,
// an optional lead sentence and optional extra content (Help's topic
// links), with an optional side column (Earnings' author share). No photo.
export function PageBand({
  eyebrow,
  title,
  lead,
  children,
  aside,
}: {
  eyebrow: string;
  title: string;
  lead?: ReactNode;
  children?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <section className="bg-primary text-primary-foreground">
      <div
        className={`page-container py-10 lg:py-14 ${aside ? "grid gap-8 md:grid-cols-[1fr_auto] md:items-end md:gap-14" : ""}`}
      >
        <div className="max-w-2xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-5 font-serif text-4xl font-normal leading-[1.1] sm:text-5xl">{title}</h1>
          {lead && (
            <p className="mt-5 max-w-xl text-base leading-relaxed text-primary-foreground/85 md:text-lg">{lead}</p>
          )}
          {children}
        </div>
        {aside}
      </div>
    </section>
  );
}

// The home page's closing "Ready to publish your book?" band, word for
// word; the button is the caller's (resolveHomepageCta /
// resolveAuthorPageCta).
export function ClosingCtaBand({ cta }: { cta: HomepageCta }) {
  return (
    <section className="bg-primary text-primary-foreground">
      <div className="mx-auto w-full max-w-content px-4 py-12 text-center sm:px-6 md:py-14">
        <h2 className="font-serif text-3xl font-normal sm:text-[2.875rem] sm:leading-tight">
          Ready to publish your book?
        </h2>
        <p className="mt-3 text-lg text-primary-foreground/85">
          Create your first book on Librum and publish on your terms.
        </p>
        {/* REDESIGN STEP 2: both lines above the button, as in the mockup. */}
        <p className="mt-2 text-primary-foreground/80">No setup fee. No monthly subscription.</p>
        <Link href={cta.href} className={`${BRASS_CTA_CLASSES} mt-6`}>
          {cta.label}
        </Link>
      </div>
    </section>
  );
}
