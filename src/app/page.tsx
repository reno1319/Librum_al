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

      <div className="mx-auto flex w-full max-w-wide flex-col gap-16 px-4 py-16 sm:px-6">
        <WhyLibrumSection />
        <HowItWorksSection />
      </div>

      <EarningsSection />

      {remainingCovers.length > 0 && (
        <div className="mx-auto w-full max-w-wide px-4 py-16 sm:px-6">
          <PublishedWithLibrumSection covers={remainingCovers} />
        </div>
      )}

      <div className="mx-auto w-full max-w-wide px-4 py-16 sm:px-6">
        <ProfessionalToolsSection />
      </div>

      {cta.final && <FinalCtaSection cta={cta.final} />}
    </main>
  );
}

// ============================================================
// Section 1 — Hero (author-only: one CTA, no reader path)
// ============================================================

function HeroSection({ cta, covers }: { cta: HomepageCta | null; covers: Cover[] }) {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="bg-primary">
      <div className="mx-auto flex w-full max-w-wide flex-col items-center gap-10 px-4 py-16 text-center sm:px-6 md:py-20">
        <div className="max-w-2xl">
          <h1 className="font-serif text-4xl font-bold text-primary-foreground sm:text-6xl">
            Publish your book. Your way.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-lg text-primary-foreground/80">
            The self-publishing platform built for Albanian-language authors.
            Publish independently, set your own price, and reach readers
            through Librum.
          </p>

          {cta && (
            <Link
              href={cta.href}
              className="focus-ring mt-6 inline-flex items-center justify-center rounded-md bg-white px-6 py-3 text-base font-medium text-primary transition-colors hover:bg-white/90"
            >
              {cta.label}
            </Link>
          )}

          <div className="mx-auto mt-8 flex max-w-md flex-col items-center gap-1">
            <span className="font-serif text-5xl font-bold text-primary-foreground">
              {authorShare}%
            </span>
            <span className="text-sm font-medium uppercase tracking-wide text-primary-foreground/70">
              Author share
            </span>
            <p className="mt-2 text-sm text-primary-foreground/80">
              You set the price. You keep {authorShare}% of each eligible
              sale; Librum&apos;s platform fee is {PLATFORM_FEE_PERCENT}%.
            </p>
          </div>
        </div>

        {covers.length > 0 && <CoverCollage covers={covers} />}
      </div>
    </section>
  );
}

// Overlapping, editorial cover arrangement -- decorative proof, not a
// navigable shelf. Sized for exactly HERO_COVER_COUNT covers; if fewer
// are available, only that many render (no fabricated placeholders).
const COLLAGE_LAYOUT = [
  { top: "2.5rem", left: "0rem", width: "7.5rem", rotate: -3, z: 1 },
  { top: "0rem", left: "5.25rem", width: "9.5rem", rotate: 0, z: 3 },
  { top: "3rem", left: "11.5rem", width: "7rem", rotate: 3, z: 2 },
];

function CoverCollage({ covers }: { covers: Cover[] }) {
  const shown = covers.slice(0, COLLAGE_LAYOUT.length);

  return (
    <div
      className="relative mx-auto w-full max-w-xs"
      style={{ height: "17.5rem" }}
      aria-hidden="true"
    >
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
  );
}

// ============================================================
// Section 2 — Why Librum (exactly three locked pillars)
// ============================================================

const WHY_LIBRUM_PILLARS: { eyebrow: string; title: string; body: string }[] = [
  {
    eyebrow: "A new path to publishing",
    title: "Another way to reach readers",
    body: "Librum gives Albanian-language writers a direct way to bring their work to readers.",
  },
  {
    eyebrow: "Stay in control",
    title: "Your book, your terms",
    body: "You set your price, manage your listing, and control when your book is published.",
  },
  {
    eyebrow: "Find your readers",
    title: "A bookstore built for your work",
    body: "Once published, your book becomes available to readers through the Librum Bookstore.",
  },
];

function WhyLibrumSection() {
  return (
    <section>
      <h2 className="text-center font-serif text-3xl font-bold">Why Librum</h2>
      <div className="mt-10 grid gap-10 sm:grid-cols-3">
        {WHY_LIBRUM_PILLARS.map((pillar) => (
          <div key={pillar.title}>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">
              {pillar.eyebrow}
            </p>
            <h3 className="mt-2 font-serif text-lg font-bold">{pillar.title}</h3>
            <p className="mt-2 text-sm text-foreground/90">{pillar.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ============================================================
// Section 3 — How Publishing Works
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

function HowItWorksSection() {
  return (
    <section>
      <h2 className="text-center font-serif text-3xl font-bold">
        How publishing works
      </h2>
      <ol className="mt-10 grid gap-10 sm:grid-cols-2 md:grid-cols-4">
        {PUBLISHING_STEPS.map((step, i) => (
          <li key={step.title} className="text-center">
            <IconBadge icon={step.icon} />
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-primary">
              Step {i + 1}
            </p>
            <h3 className="mt-1 font-serif text-lg font-bold">{step.title}</h3>
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
    </section>
  );
}

function IconBadge({ icon: Icon }: { icon: Icon }) {
  return (
    <div className="mx-auto flex size-20 items-center justify-center rounded-full bg-primary/10">
      <Icon className="size-9 text-primary" />
    </div>
  );
}

// ============================================================
// Section 4 — Earnings (percentage-only, no worked example)
// ============================================================

function EarningsSection() {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="bg-author-tint">
      <div className="mx-auto w-full max-w-content px-4 py-16 text-center sm:px-6">
        <span className="font-serif text-5xl font-bold sm:text-6xl">
          {authorShare}%
        </span>
        <p className="mt-1 text-sm font-medium uppercase tracking-wide text-muted">
          Author share
        </p>
        <p className="mx-auto mt-4 max-w-md text-foreground/90">
          Librum keeps a {PLATFORM_FEE_PERCENT}% platform fee. No setup fee.
          No monthly subscription.
        </p>
        <Link
          href="/pricing"
          className="focus-ring mt-6 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
        >
          Learn about earnings &rarr;
        </Link>
      </div>
    </section>
  );
}

// ============================================================
// Section 5 — Published with Librum (author social proof only --
// non-clickable, no commerce of any kind)
// ============================================================

function PublishedWithLibrumSection({ covers }: { covers: Cover[] }) {
  return (
    <section>
      <h2 className="text-center font-serif text-3xl font-bold">
        Published with Librum
      </h2>
      <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted">
        Real books, published independently by Librum authors.
      </p>
      <div
        className="mt-10 grid grid-cols-3 gap-4 sm:grid-cols-5"
        aria-hidden="true"
      >
        {covers.map((cover, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={cover.id}
            src={cover.url}
            alt=""
            loading="lazy"
            className="aspect-[2/3] w-full rounded-lg object-cover shadow-sm"
            style={{
              transform: i % 2 === 0 ? "rotate(-1deg)" : "rotate(1deg)",
            }}
          />
        ))}
      </div>
    </section>
  );
}

// ============================================================
// Section 6 — Professional Tools (exactly three grounded claims)
// ============================================================

const PROFESSIONAL_TOOLS = [
  "Set your own price",
  "Track sales from your dashboard",
  "Receive payouts through Stripe",
];

function ProfessionalToolsSection() {
  return (
    <section>
      <h2 className="text-center font-serif text-3xl font-bold">
        Simple to start. Built for the long run.
      </h2>
      <ul className="mx-auto mt-8 flex max-w-md flex-col gap-4">
        {PROFESSIONAL_TOOLS.map((item) => (
          <li key={item} className="flex items-center gap-3 text-sm">
            <IconCheck className="size-5 shrink-0 text-primary" />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ============================================================
// Section 7 — Final CTA (author-only; omitted entirely for readers)
// ============================================================

function FinalCtaSection({ cta }: { cta: HomepageCta }) {
  return (
    <section className="bg-surface-hover">
      <div className="mx-auto w-full max-w-content px-4 py-16 text-center sm:px-6">
        <h2 className="font-serif text-3xl font-bold sm:text-4xl">
          Your book is one upload away.
        </h2>
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
