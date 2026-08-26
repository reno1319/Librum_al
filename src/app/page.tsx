import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { resolveHomepageCta, computeAuthorSharePercent, type HomepageCta } from "@/lib/homepage";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import {
  IconUpload,
  IconBookOpen,
  IconBolt,
  IconChart,
  IconCheck,
} from "@/components/icons";
import type { Book } from "@/lib/types";
import type { ComponentType, CSSProperties } from "react";
import type { Metadata } from "next";

// LIBRUM 2.0 UI-3: this page is the AUTHOR/self-publishing homepage --
// permanent product boundary, locked by this phase: HOMEPAGE = AUTHORS,
// BOOKSTORE = READERS. No prices, no Buy buttons, no reader
// merchandising, no reader CTA anywhere below. The Bookstore is
// mentioned exactly once, as an author benefit (see WhyLibrumSection's
// third pillar) -- never as a shopping destination from this page.
//
// LIBRUM 2.0 UI-3 visual refinement pass: same product architecture and
// copy strategy as the original UI-3 build, restructured section by
// section for a tighter, quieter, more editorial layout -- each section
// owns its own <section> + inner max-w container (rather than several
// sections sharing one wrapping div) so each can be given its own
// content-driven vertical rhythm.

export const metadata: Metadata = {
  title: "Librum — Self-Publish Your Ebook",
  description:
    "The self-publishing platform built for Albanian-language authors. Publish independently, set your own price, and reach readers through Librum.",
};

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// LIBRUM 2.0 UI-3: ONE query serves both the hero's small cover
// arrangement and the "Published with Librum" proof section below --
// no second book query merely to make the two sections look different
// (see resolveCoverSplit). Capped at 8, matching the locked "fetch no
// more than 8 published covers" instruction.
const MAX_HOMEPAGE_COVERS = 8;
const HERO_COVER_COUNT = 3;

async function fetchPublishedCovers(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("books")
    .select("id, cover_path")
    .eq("status", "published")
    .not("cover_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_HOMEPAGE_COVERS)
    .returns<Pick<Book, "id" | "cover_path">[]>();

  return (data ?? []).map((b) => ({
    id: b.id,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data.publicUrl,
  }));
}

type Cover = { id: string; url: string };

// Splits one fetched cover list into the hero's small arrangement (up
// to HERO_COVER_COUNT) and the remainder for "Published with Librum" --
// never the same cover shown in both places. At 1-3 total covers, the
// remainder is naturally empty and that later section omits itself
// (see PublishedWithLibrumSection) rather than repeating the hero's own
// covers, which would look artificial.
function resolveCoverSplit(covers: Cover[]) {
  return {
    hero: covers.slice(0, HERO_COVER_COUNT),
    remaining: covers.slice(HERO_COVER_COUNT),
  };
}

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
  const { hero: heroCovers, remaining: remainingCovers } = resolveCoverSplit(covers);

  return (
    <main className="flex-1">
      {account === "deleted" && (
        <div className="mx-auto w-full max-w-wide px-4 pt-10 sm:px-6">
          <Alert variant="success">Your account has been deleted.</Alert>
        </div>
      )}

      <HeroSection cta={cta.hero} covers={heroCovers} />
      <WhyLibrumSection />
      <PublishInFourStepsSection />
      <EarningsSection />
      {remainingCovers.length > 0 && (
        <PublishedWithLibrumSection covers={remainingCovers} />
      )}
      <ProfessionalToolsSection />
      {cta.final && <FinalCtaSection cta={cta.final} />}
    </main>
  );
}

// ============================================================
// Section 1 — Hero: compact two-column editorial layout (author-only:
// one CTA, no reader path). Paper background, not full-viewport
// violet -- target 500-560px including padding.
// ============================================================

function HeroSection({ cta, covers }: { cta: HomepageCta | null; covers: Cover[] }) {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="bg-background">
      <div className="mx-auto w-full max-w-wide px-4 py-16 sm:px-6 lg:py-20">
        <div
          className={
            covers.length > 0
              ? "grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-10"
              : ""
          }
        >
          <div className="max-w-xl">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Self-publishing for Albanian-language authors
            </p>
            <h1 className="mt-3 font-serif text-4xl font-bold leading-tight sm:text-5xl lg:text-6xl">
              Publish your book. Your way.
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

            <div className="mt-6 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-sm">
              <span className="font-semibold text-foreground">
                {authorShare}%{" "}
                <span className="font-normal text-muted">Author share</span>
              </span>
              <span aria-hidden="true" className="text-muted">
                &middot;
              </span>
              <span className="text-muted">You set the price</span>
              <span aria-hidden="true" className="text-muted">
                &middot;
              </span>
              <span className="text-muted">No setup fee</span>
              <span aria-hidden="true" className="text-muted">
                &middot;
              </span>
              <span className="text-muted">No monthly subscription</span>
            </div>
          </div>

          {covers.length > 0 && <HeroCovers covers={covers} />}
        </div>
      </div>
    </section>
  );
}

// Decorative, editorial cover arrangement -- proof, not a navigable
// shelf. On mobile: a compact row directly below the hero copy. On
// desktop: a restrained overlapping stagger, contained well within the
// hero's target height. Sized for exactly HERO_COVER_COUNT covers; if
// fewer are available, only that many render (no fabricated
// placeholders).
const COLLAGE_LAYOUT = [
  { top: "2rem", left: "0rem", width: "7.75rem", rotate: -3, z: 1 },
  { top: "0rem", left: "5.5rem", width: "9.75rem", rotate: 0, z: 3 },
  { top: "2.75rem", left: "12rem", width: "7.5rem", rotate: 3, z: 2 },
];

function HeroCovers({ covers }: { covers: Cover[] }) {
  const shown = covers.slice(0, COLLAGE_LAYOUT.length);

  return (
    <div aria-hidden="true">
      <div className="flex gap-3 lg:hidden">
        {shown.map((cover) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={cover.id}
            src={cover.url}
            alt=""
            loading="lazy"
            className="aspect-[2/3] w-20 flex-1 max-w-28 rounded-md object-cover shadow-sm"
          />
        ))}
      </div>

      <div
        className="relative hidden max-w-sm lg:block"
        style={{ height: "15rem" }}
      >
        <div className="absolute -inset-6 -z-10 rounded-3xl bg-primary/10" />
        {shown.map((cover, i) => {
          const layout = COLLAGE_LAYOUT[i];
          return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={cover.id}
              src={cover.url}
              alt=""
              loading={i === 0 ? "eager" : "lazy"}
              className="absolute aspect-[2/3] rounded-lg object-cover shadow-lg"
              style={{
                top: layout.top,
                left: layout.left,
                width: layout.width,
                zIndex: layout.z,
                transform: `rotate(${layout.rotate}deg)`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Section 2 — Why Librum (exactly three locked pillars). Simplified:
// each pillar is now a single heading (the former uppercase eyebrow
// text, promoted to a real heading) plus its approved body copy -- no
// separate eyebrow + title duplication.
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
    <section className="border-t border-border">
      <div className="mx-auto w-full max-w-app px-4 py-14 sm:px-6">
        <h2 className="font-serif text-2xl font-bold sm:text-3xl">Why Librum</h2>
        <div className="mt-8 grid gap-8 sm:grid-cols-3">
          {WHY_LIBRUM_PILLARS.map((pillar, i) => (
            <div key={pillar.heading}>
              <span className="font-serif text-xs font-semibold text-primary/60">
                {String(i + 1).padStart(2, "0")}
              </span>
              <h3 className="mt-1 font-serif text-lg font-bold">{pillar.heading}</h3>
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
// Section 3 — Publish in four steps (renamed from "How publishing
// works"; tighter icons and spacing)
// ============================================================

const PUBLISHING_STEPS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Prepare your manuscript",
    body: "Have your finished book ready as an EPUB file, along with a cover image.",
    icon: IconUpload,
  },
  {
    title: "Create your book",
    body: "Add your title, description, genre, cover, and publishing information.",
    icon: IconBookOpen,
  },
  {
    title: "Set your price and publish",
    body: "Choose your price, review your listing, and publish when you're ready.",
    icon: IconBolt,
  },
  {
    title: "Sell and earn",
    body: "Track sales and revenue from your dashboard, with author payouts handled through Stripe.",
    icon: IconChart,
  },
];

function PublishInFourStepsSection() {
  return (
    <section className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-app px-4 py-16 sm:px-6 md:py-20">
        <h2 className="text-center font-serif text-2xl font-bold sm:text-3xl">
          Publish in four steps
        </h2>
        <ol className="mt-10 grid gap-6 sm:grid-cols-2 md:grid-cols-4">
          {PUBLISHING_STEPS.map((step, i) => (
            <li key={step.title} className="text-center">
              <IconBadge icon={step.icon} />
              <p className="mt-3 text-xs font-bold uppercase tracking-[0.08em] text-primary">
                Step {i + 1}
              </p>
              <h3 className="mt-1 font-serif text-base font-bold">{step.title}</h3>
              <p className="mt-1 text-sm text-foreground/90">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8 text-center">
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

function IconBadge({ icon: Icon }: { icon: Icon }) {
  return (
    <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-primary/10">
      <Icon className="size-6 text-primary" />
    </div>
  );
}

// ============================================================
// Section 4 — Earnings: compact two-column band (percentage-only, no
// worked example)
// ============================================================

function EarningsSection() {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="bg-author-tint">
      <div className="mx-auto grid w-full max-w-app gap-6 px-4 py-10 sm:grid-cols-2 sm:items-center sm:px-6 md:py-12">
        <div>
          <span className="font-serif text-5xl font-bold sm:text-6xl">
            {authorShare}%
          </span>
          <p className="mt-1 text-sm font-medium uppercase tracking-wide text-muted">
            Author share
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            Earnings
          </p>
          <p className="mt-1 leading-relaxed text-foreground/90">
            Librum keeps a {PLATFORM_FEE_PERCENT}% platform fee. No setup
            fee. No monthly subscription.
          </p>
          <Link
            href="/pricing"
            className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
          >
            Learn about earnings &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 5 — Published with Librum (author social proof only --
// non-clickable, no commerce of any kind). Smaller covers, ~150-180px
// each on desktop.
// ============================================================

// Restrained editorial vertical stagger, cycling by index -- distinct
// from PublishedWithLibrumSection's own rotation (kept extremely
// subtle), so the row reads as composed rather than a flat grid without
// tipping into a playful/chaotic arrangement.
const PUBLISHED_STAGGER = ["0.25rem", "-0.25rem", "0.5rem", "-0.25rem", "0.25rem"];

function PublishedWithLibrumSection({ covers }: { covers: Cover[] }) {
  return (
    <section className="border-t border-border">
      <div className="mx-auto w-full max-w-wide px-4 py-14 sm:px-6">
        <h2 className="text-center font-serif text-2xl font-bold sm:text-3xl">
          Published with Librum
        </h2>
        <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted">
          Real books, published independently by Librum authors.
        </p>
        <div
          className="mt-10 flex flex-wrap justify-center gap-4"
          aria-hidden="true"
        >
          {covers.map((cover, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={cover.id}
              src={cover.url}
              alt=""
              loading="lazy"
              className="aspect-[2/3] w-[clamp(6.5rem,20vw,10.5rem)] rounded-lg object-cover shadow-sm"
              style={{
                transform: `translateY(${PUBLISHED_STAGGER[i % PUBLISHED_STAGGER.length]}) rotate(${i % 2 === 0 ? -1 : 1}deg)`,
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 6 — Professional Tools (exactly three grounded claims, now
// three real columns instead of a narrow centered checklist)
// ============================================================

const PROFESSIONAL_TOOLS: { title: string; body: string }[] = [
  {
    title: "Set your own price",
    body: "You choose your book's price and can change it whenever you need.",
  },
  {
    title: "Track your sales",
    body: "Follow units sold and revenue from your author dashboard.",
  },
  {
    title: "Receive payouts through Stripe",
    body: "Author payouts are handled securely through Stripe.",
  },
];

function ProfessionalToolsSection() {
  return (
    <section className="border-t border-border bg-surface">
      <div className="mx-auto w-full max-w-app px-4 py-12 sm:px-6 md:py-14">
        <h2 className="text-center font-serif text-2xl font-bold sm:text-3xl">
          Simple to start. Built for the long run.
        </h2>
        <div className="mt-10 grid gap-8 sm:grid-cols-3">
          {PROFESSIONAL_TOOLS.map((tool) => (
            <div key={tool.title}>
              <IconCheck className="size-8 text-primary" />
              <h3 className="mt-3 font-serif text-lg font-bold">{tool.title}</h3>
              <p className="mt-2 text-base text-foreground/90">{tool.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 7 — Final CTA (author-only; omitted entirely for readers)
// ============================================================

function FinalCtaSection({ cta }: { cta: HomepageCta }) {
  return (
    <section className="border-t border-border bg-surface-hover">
      <div className="mx-auto w-full max-w-content px-4 py-16 text-center sm:px-6 md:py-20">
        <h2 className="font-serif text-3xl font-bold sm:text-4xl">
          Ready to publish?
        </h2>
        <p className="mt-2 text-foreground/90">
          Bring your book to readers with Librum.
        </p>
        <Link
          href={cta.href}
          className={buttonClasses("primary", "lg", "mt-6 inline-flex")}
        >
          {cta.label}
        </Link>
      </div>
    </section>
  );
}
