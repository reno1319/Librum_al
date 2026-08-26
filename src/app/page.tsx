import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { resolveHomepageCta, computeAuthorSharePercent, type HomepageCta } from "@/lib/homepage";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { IconTag, IconChart, IconBank, IconCheck } from "@/components/icons";
import type { Book } from "@/lib/types";
import type { ComponentType, CSSProperties } from "react";
import type { Metadata } from "next";

// LIBRUM 2.0 UI-3: this page is the AUTHOR/self-publishing homepage --
// permanent product boundary, locked by this phase: HOMEPAGE = AUTHORS,
// BOOKSTORE = READERS. No prices, no Buy buttons, no reader
// merchandising, no reader CTA anywhere below. The Bookstore is
// mentioned exactly once, as an author benefit/proof, and once as a
// quiet text link under "Published with Librum" (never as a shopping
// destination from this page).
//
// LIBRUM 2.0 GLOBAL VISUAL POLISH 1: same product architecture and copy
// strategy as UI-3, restructured for a richer editorial visual language
// -- three distinct kinds of visual material (hero photography, small
// Librum-specific product mockups in "Publish in four steps," and real
// published-book covers as proof), an alternating pale-tint/paper
// section rhythm instead of full-width divider lines, and a tighter
// vertical rhythm throughout. No new business logic: resolveHomepageCta()
// and computeAuthorSharePercent() are reused exactly as before.

// LIBRUM 2.0 SEO-1: `absolute` deliberately opts this one page out of the
// root layout's "%s | Librum" title template -- the homepage's own title
// already IS the full brand title, so applying the template on top of it
// would produce "Librum — Self-Publish Your Ebook | Librum".
export const metadata: Metadata = {
  title: { absolute: "Librum — Self-Publish Your Ebook" },
  description:
    "The self-publishing platform built for Albanian-language authors. Publish independently, set your own price, and reach readers through Librum.",
};

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// LIBRUM 2.0 UI-3: fetches the covers "Published with Librum" shows as
// proof. Capped at 8, matching the locked "fetch no more than 8
// published covers" instruction. GLOBAL VISUAL POLISH 1: the hero no
// longer shows any covers at all (see section 4 of the approved design
// -- covers belong to "Published with Librum" only, never the hero), so
// every fetched cover is available to that one section; no split is
// needed any more. `title` is now selected alongside `id`/`cover_path`
// -- covers became real links to /books/{id} in this pass, and a linked,
// otherwise-decorative cover image needs SOME accessible name (see
// PublishedWithLibrumSection's aria-label) -- this is the same single
// query, extended by one scalar column, not a new query.
const MAX_HOMEPAGE_COVERS = 8;

async function fetchPublishedCovers(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("books")
    .select("id, title, cover_path")
    .eq("status", "published")
    .not("cover_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_HOMEPAGE_COVERS)
    .returns<Pick<Book, "id" | "title" | "cover_path">[]>();

  return (data ?? []).map((b) => ({
    id: b.id,
    title: b.title,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data.publicUrl,
  }));
}

type Cover = { id: string; title: string; url: string };

// LIBRUM 2.0 GLOBAL VISUAL POLISH 1 / HERO-ASSET-1: resolved -- the
// approved production photograph lives at public/images/author-hero.jpg,
// served at this path. See HeroMedia's own comment for the crop
// reasoning (the image is a wide desk flat-lay, ~2560x1429/16:9-ish;
// object-position is tuned per breakpoint against its actual content).
const HERO_IMAGE_SRC = "/images/author-hero.jpg";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const { account } = await searchParams;
  const supabase = await createClient();

  const [covers, userResult] = await Promise.all([
    fetchPublishedCovers(supabase),
    supabase.auth.getUser(),
  ]);
  const user = userResult.data.user;

  // Same minimal, page-local user/profile resolution pattern already
  // used throughout this codebase (dashboard pages, account page, the
  // header itself) -- no shared "resolve current user+role" helper
  // exists to import, and this page's own CTA decision
  // (resolveHomepageCta) is intentionally a separate, homepage-local
  // boundary from the header's buildSiteHeaderNav(), per the UI-3
  // design.
  let role: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    role = profile?.role ?? null;
  }

  const cta = resolveHomepageCta({ user: user ? { id: user.id } : null, role });

  return (
    <main className="flex-1">
      {account === "deleted" && (
        <div className="mx-auto w-full max-w-wide px-4 pt-10 sm:px-6">
          <Alert variant="success">Your account has been deleted.</Alert>
        </div>
      )}

      <HeroSection cta={cta.hero} />
      <WhyLibrumSection />
      <PublishInFourStepsSection />
      <EarningsSection />
      {covers.length > 0 && <PublishedWithLibrumSection covers={covers} />}
      <ProfessionalToolsSection />
      {cta.final && <FinalCtaSection cta={cta.final} />}
    </main>
  );
}

// ============================================================
// Section 1 — Hero: compact editorial two-column layout (author-only:
// one CTA, no reader path). Pale Librum-violet tint, not the same paper
// tone as the sections below it. The book-cover collage that used to
// occupy the right column is gone entirely -- see HeroMedia.
// ============================================================

function HeroSection({ cta }: { cta: HomepageCta | null }) {
  const authorShare = computeAuthorSharePercent();
  const proofPoints = [
    `${authorShare}% author share`,
    "You set the price",
    "No setup fee",
    "No monthly subscription",
  ];

  return (
    <section className="bg-violet-tint">
      <div className="mx-auto w-full max-w-wide px-4 py-12 sm:px-6 lg:py-16">
        <div className="grid gap-10 lg:grid-cols-[55fr_45fr] lg:items-center lg:gap-12">
          <div className="max-w-xl">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Self-publishing for Albanian-language authors
            </p>
            <h1 className="mt-3 font-serif text-4xl font-bold leading-[1.1] sm:text-5xl lg:text-[3.5rem]">
              Publish your book.
              <br />
              Your way.
            </h1>
            <p className="mt-4 max-w-md text-base leading-relaxed text-foreground/80 md:text-lg">
              The self-publishing platform built for Albanian-language
              authors. Publish independently, set your own price, and reach
              readers through Librum.
            </p>

            {cta && (
              <Link href={cta.href} className={buttonClasses("primary", "lg", "mt-6 inline-flex")}>
                {cta.label}
              </Link>
            )}

            <div className="mt-7 flex flex-wrap gap-x-8 gap-y-2 lg:flex-nowrap lg:gap-x-4">
              {proofPoints.map((point) => (
                <p
                  key={point}
                  className="text-sm font-medium whitespace-nowrap text-foreground/90"
                >
                  {point}
                </p>
              ))}
            </div>
          </div>

          <HeroMedia />
        </div>
      </div>
    </section>
  );
}

// Editorial photography slot -- writer/manuscript/desk photography,
// never a book cover, never a generic SaaS/office stock photo. The
// approved source (public/images/author-hero.jpg) is a wide overhead
// desk flat-lay, ~2560x1429 (~16:9-ish), with the typewriter and typing
// hands centered horizontally and occupying roughly the vertical middle
// third down through the bottom edge of the frame -- the surrounding
// books/plants/mugs sit at the outer edges.
//
// object-fit: cover math against that source: at aspect-video (16:9 ≈
// the source's own ratio) essentially the full frame shows uncropped,
// which is why mobile uses it -- a short "full scene" band under the
// copy, not a huge block (no huge hero height). At the taller lg:
// aspect-[4/5], the source is wider than the box, so cover scales to
// the box's full height with zero vertical crop and crops horizontally
// to a centered ~45%-width slice -- object-center keeps that slice
// centered exactly on the typewriter/hands, cropping away the outer
// clutter, which is the intentional tighter "focused" desktop crop.
function HeroMedia() {
  return (
    <div className="mx-auto w-full max-w-[480px] lg:mx-0 lg:ml-auto">
      <div className="aspect-video overflow-hidden rounded-lg border border-primary/10 shadow-md lg:aspect-[4/5]">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={HERO_IMAGE_SRC}
          alt=""
          loading="eager"
          fetchPriority="high"
          className="h-full w-full object-cover object-center"
        />
      </div>
    </div>
  );
}

// ============================================================
// Section 2 — Why Librum (exactly three locked pillars). Large quiet
// editorial numerals replace the old tiny eyebrow-style digits.
// ============================================================

const WHY_LIBRUM_PILLARS: { heading: string; body: string }[] = [
  {
    heading: "A new path to publishing",
    body: "Librum gives Albanian-language writers a direct way to bring their work to readers.",
  },
  {
    heading: "Stay in control",
    body: "You set your price, manage your listing, and control when your book is published.",
  },
  {
    heading: "Find your readers",
    body: "Once published, your book becomes available to readers through the Librum Bookstore.",
  },
];

function WhyLibrumSection() {
  return (
    <section className="bg-background">
      <div className="mx-auto w-full max-w-app px-4 py-11 sm:px-6">
        <h2 className="font-serif text-2xl font-bold sm:text-3xl">Why Librum</h2>
        <p className="mt-2 max-w-xl text-foreground/80">
          A direct way for Albanian-language writers to publish
          professionally and reach readers.
        </p>

        <div className="mt-10 grid gap-10 sm:grid-cols-3">
          {WHY_LIBRUM_PILLARS.map((pillar, i) => (
            <div key={pillar.heading} className="group">
              <span className="block font-serif text-[2.75rem] font-bold leading-none text-primary/25 transition-colors duration-150 group-hover:text-primary/45 sm:text-5xl">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-3 font-serif text-lg font-bold">{pillar.heading}</h3>
              <p className="mt-2 text-sm leading-relaxed text-foreground/90 md:text-base">
                {pillar.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 3 — Publish in four steps. Generic circular icons are gone;
// each step is now a 01→02→03→04 progression with a small
// Librum-specific mini mockup (plain HTML/CSS, not a screenshot, not
// fake data) instead.
// ============================================================

const PUBLISHING_STEPS: { title: string; body: string }[] = [
  {
    title: "Prepare your manuscript",
    body: "Have your finished book ready as an EPUB file, along with a cover image.",
  },
  {
    title: "Create your book",
    body: "Add your title, description, genre, cover, and publishing information.",
  },
  {
    title: "Set your price and publish",
    body: "Choose your price, review your listing, and publish when you're ready.",
  },
  {
    title: "Sell and earn",
    body: "Track sales and revenue from your dashboard, with author payouts handled through Stripe.",
  },
];

function PublishInFourStepsSection() {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="bg-surface">
      <div className="mx-auto w-full max-w-app px-4 py-12 sm:px-6 md:py-16">
        <h2 className="text-center font-serif text-2xl font-bold sm:text-3xl">
          Publish in four steps
        </h2>
        <ol className="mt-12 grid gap-y-12 gap-x-6 sm:grid-cols-2 md:grid-cols-4">
          {PUBLISHING_STEPS.map((step, i) => (
            <li key={step.title} className="group text-center">
              <span
                className={
                  i > 0
                    ? "relative inline-block font-serif text-3xl font-bold text-primary/70 md:before:absolute md:before:right-full md:before:top-1/2 md:before:h-px md:before:w-6 md:before:-translate-y-1/2 md:before:bg-border md:before:content-['']"
                    : "relative inline-block font-serif text-3xl font-bold text-primary/70"
                }
              >
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-2 font-serif text-base font-bold">{step.title}</h3>
              <p className="mt-1 text-sm text-foreground/90">{step.body}</p>
              <div className="mt-4 flex justify-center">
                <StepMockup step={i + 1} authorShare={authorShare} />
              </div>
            </li>
          ))}
        </ol>
        <div className="mt-10 text-center">
          <Link
            href="/how-it-works"
            className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline"
          >
            Read the full guide &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// Small, stylized, Librum-specific presentation elements -- plain
// Tailwind/HTML, not screenshots and not real functionality. Numeric
// content is either derived from the real economics helper
// (authorShare) or a neutral em-dash/label -- never a fabricated
// "impressive" figure. Purely illustrative/redundant with the step's
// own heading+body text, so each is aria-hidden.
function StepMockup({ step, authorShare }: { step: number; authorShare: number }) {
  const cardClasses =
    "w-full max-w-[220px] rounded-lg border border-border bg-background p-3 text-left text-xs shadow-sm transition-[transform,border-color] duration-150 group-hover:-translate-y-0.5 group-hover:border-primary/30 motion-reduce:transition-none motion-reduce:group-hover:translate-y-0";

  if (step === 1) {
    return (
      <div className={cardClasses} aria-hidden="true">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Cover</p>
        <div className="mt-1 aspect-[2/3] w-9 rounded bg-border" />
        <p className="mt-2 text-[10px] font-medium uppercase tracking-wide text-muted">
          Manuscript
        </p>
        <p className="mt-1 flex items-center gap-1 text-foreground/80">
          manuscript.epub <IconCheck className="size-3 text-primary" />
        </p>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className={cardClasses} aria-hidden="true">
        <div className="flex flex-col gap-1.5">
          {["Title", "Genre", "Description", "Keywords"].map((field) => (
            <span
              key={field}
              className="rounded border border-border px-2 py-1 text-foreground/70"
            >
              {field}
            </span>
          ))}
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className={cardClasses} aria-hidden="true">
        <div className="flex items-center justify-between">
          <span className="text-muted">Price</span>
          <span className="font-medium text-foreground">$—</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <span className="text-muted">Author share</span>
          <span className="font-medium text-foreground">{authorShare}%</span>
        </div>
        <span className="mt-2.5 inline-flex rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground">
          Publish book
        </span>
      </div>
    );
  }

  return (
    <div className={cardClasses} aria-hidden="true">
      <div className="flex items-center justify-between">
        <span className="text-muted">Sales</span>
        <span className="font-medium text-foreground">—</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-muted">Earnings</span>
        <span className="font-medium text-foreground">—</span>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-muted">Payout status</span>
        <span className="font-medium text-foreground">Pending</span>
      </div>
    </div>
  );
}

// ============================================================
// Section 4 — Earnings: a stronger editorial band. Pale cool
// lavender-blue background (the same author-tint token used elsewhere
// in this codebase for author-zone surfaces), an oversized low-opacity
// numeral purely as texture, and one coherent proposition instead of a
// bare percentage.
// ============================================================

function EarningsSection() {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="relative overflow-hidden bg-author-tint">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute -right-6 -top-12 select-none font-serif text-[11rem] font-bold leading-none text-primary/5 sm:text-[14rem]"
      >
        {authorShare}
      </span>
      <div className="relative z-10 mx-auto grid w-full max-w-app gap-8 px-4 py-14 sm:grid-cols-2 sm:items-center sm:px-6 md:py-16">
        <div>
          <span className="font-serif text-6xl font-bold sm:text-7xl">{authorShare}%</span>
          <p className="mt-1 text-sm font-medium uppercase tracking-wide text-muted">
            Author share
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Earnings</p>
          <h2 className="mt-1 font-serif text-2xl font-bold sm:text-3xl">
            Keep more of every eligible sale.
          </h2>
          <p className="mt-2 leading-relaxed text-foreground/90">
            Librum keeps a {PLATFORM_FEE_PERCENT}% platform fee. No setup
            fee. No monthly subscription.
          </p>
          <Link
            href="/pricing"
            className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
          >
            See how earnings work &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 5 — Published with Librum: the homepage's primary book-cover
// proof moment now that covers are gone from the hero. Real published
// covers, staged with restrained offsets/rotation inside a soft
// editorial gallery field on desktop; a native horizontally-scrollable
// strip on mobile. Non-commerce: covers link to /books/{id} (proof that
// Librum books reach the public marketplace) but never show price/Buy/
// wishlist/rating.
// ============================================================

const PUBLISHED_STAGGER = [
  "0.3rem",
  "-0.4rem",
  "0.55rem",
  "-0.3rem",
  "0.45rem",
  "-0.5rem",
  "0.35rem",
  "-0.25rem",
];

function PublishedWithLibrumSection({ covers }: { covers: Cover[] }) {
  return (
    <section className="bg-background">
      <div className="mx-auto w-full max-w-wide px-4 py-12 sm:px-6">
        <h2 className="text-center font-serif text-2xl font-bold sm:text-3xl">
          Published with Librum
        </h2>
        <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted">
          Books brought to readers by independent Librum authors.
        </p>

        {/* Mobile: native horizontal scroll, no JS carousel -- a partial
            next cover stays visible at the right edge when there are
            enough covers to overflow the viewport. */}
        <div className="-mx-4 mt-8 overflow-x-auto px-4 pb-2 sm:hidden">
          <div className="flex w-max gap-3">
            {covers.map((cover) => (
              <Link
                key={cover.id}
                href={`/books/${cover.id}`}
                aria-label={`View ${cover.title} on Librum`}
                className="focus-ring shrink-0 rounded-md"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cover.url}
                  alt=""
                  loading="lazy"
                  className="aspect-[2/3] w-[144px] rounded-md object-cover shadow-sm"
                />
              </Link>
            ))}
          </div>
        </div>

        {/* Desktop: a restrained staged gallery inside a soft editorial
            field -- not a flat baseline, not a chaotic overlap. */}
        <div className="mt-10 hidden justify-center rounded-2xl bg-surface p-10 shadow-sm ring-1 ring-border/60 sm:flex">
          <div className="flex flex-wrap justify-center gap-5">
            {covers.map((cover, i) => (
              <Link
                key={cover.id}
                href={`/books/${cover.id}`}
                aria-label={`View ${cover.title} on Librum`}
                className="focus-ring group/cover rounded-lg"
                style={{
                  transform: `translateY(${PUBLISHED_STAGGER[i % PUBLISHED_STAGGER.length]}) rotate(${i % 2 === 0 ? -1 : 1}deg)`,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cover.url}
                  alt=""
                  loading="lazy"
                  className="aspect-[2/3] w-[clamp(7.5rem,22vw,13rem)] rounded-lg object-cover shadow-sm transition-[transform,box-shadow] duration-150 group-hover/cover:-translate-y-1 group-hover/cover:shadow-md motion-reduce:transition-none motion-reduce:group-hover/cover:translate-y-0"
                />
              </Link>
            ))}
          </div>
        </div>

        <div className="mt-6 text-center">
          <Link
            href="/bookstore"
            className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline"
          >
            See published books &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 6 & 7 — Professional Tools + Final CTA: one closing sequence
// in two connected stages (background-change transition, no divider
// line between them) -- confidence-building tools, then the final
// conversion moment.
// ============================================================

const PROFESSIONAL_TOOLS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Set your own price",
    body: "Choose your price and change it whenever you need.",
    icon: IconTag,
  },
  {
    title: "Track your sales",
    body: "Follow units sold and revenue from your author dashboard.",
    icon: IconChart,
  },
  {
    title: "Receive payouts through Stripe",
    body: "Author payouts are handled securely through Stripe.",
    icon: IconBank,
  },
];

function ProfessionalToolsSection() {
  return (
    <section className="bg-surface">
      <div className="mx-auto w-full max-w-app px-4 py-11 sm:px-6 md:py-14">
        <h2 className="text-center font-serif text-2xl font-bold sm:text-3xl">
          Simple to start. Built for the long run.
        </h2>
        <div className="mt-10 grid gap-6 sm:grid-cols-3">
          {PROFESSIONAL_TOOLS.map((tool) => (
            <div
              key={tool.title}
              className="rounded-lg border border-border bg-background p-6 transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-primary/30 focus-within:-translate-y-0.5 focus-within:border-primary/30 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
            >
              <tool.icon className="size-8 text-primary" />
              <h3 className="mt-3 font-serif text-lg font-bold">{tool.title}</h3>
              <p className="mt-2 text-base text-foreground/90">{tool.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCtaSection({ cta }: { cta: HomepageCta }) {
  return (
    <section className="bg-violet-tint">
      <div className="mx-auto w-full max-w-content px-4 py-16 text-center sm:px-6 md:py-20">
        <h2 className="font-serif text-3xl font-bold sm:text-4xl">
          Ready to publish your book?
        </h2>
        <p className="mt-2 text-foreground/90">
          Create your first book on Librum and publish on your terms.
        </p>
        <Link href={cta.href} className={buttonClasses("primary", "lg", "mt-6 inline-flex")}>
          {cta.label}
        </Link>
        <p className="mt-4 text-sm text-muted">No setup fee. No monthly subscription.</p>
      </div>
    </section>
  );
}
