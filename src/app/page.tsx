import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { BookShelf } from "@/components/book-shelf";
import {
  IconUpload,
  IconBookOpen,
  IconBolt,
  IconChart,
  IconCheck,
} from "@/components/icons";
import type { Book, Profile } from "@/lib/types";
import type { ComponentType, CSSProperties } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Librum — Publish and Discover Albanian Ebooks",
  description:
    "Librum is the digital publishing platform and bookstore for Albanian-language ebooks. Publish your book, reach readers, and discover your next read.",
};

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;
type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };

async function fetchHeroCovers(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("books")
    .select("id, cover_path")
    .eq("status", "published")
    .not("cover_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(12)
    .returns<Pick<Book, "id" | "cover_path">[]>();

  return (data ?? []).map((b) => ({
    id: b.id,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data
      .publicUrl,
  }));
}

// Same query shape as fetchCuratedHome's "New releases" shelf on
// /bookstore (status=published, newest first, joined to the author's
// display name) — reused here rather than re-derived, just without the
// bestseller/hero split that page also computes.
async function fetchLatestBooks(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("books")
    .select("*, profiles(display_name)")
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(9)
    .returns<BookWithAuthor[]>();

  return data ?? [];
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const { account } = await searchParams;
  const supabase = await createClient();
  const [heroCovers, latestBooks] = await Promise.all([
    fetchHeroCovers(supabase),
    fetchLatestBooks(supabase),
  ]);

  return (
    <main className="flex-1">
      {account === "deleted" && (
        <div className="mx-auto w-full max-w-5xl px-4 pt-10 sm:px-6">
          <p className="rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
            Your account has been deleted.
          </p>
        </div>
      )}

      <HeroSection covers={heroCovers} />

      <div className="mx-auto w-full max-w-5xl px-4 sm:px-6">
        <BookDiscoverySection books={latestBooks} supabase={supabase} />
        <AuthorValueSection />
        <HowItWorksSection />
        <ReaderExperienceSection covers={heroCovers} />
      </div>

      <EarningsSection />
      <FinalCtaSection />
    </main>
  );
}

// ============================================================
// Section 1 — Hero
// ============================================================

function HeroSection({ covers }: { covers: { id: string; url: string }[] }) {
  return (
    <section style={{ backgroundColor: "#6a5cf0" }}>
      <div
        className="mx-auto w-full max-w-2xl px-4 text-center sm:px-6"
        style={{ paddingTop: "3.5rem", paddingBottom: "2rem" }}
      >
        <h1
          className="font-serif text-4xl font-bold sm:text-6xl"
          style={{ color: "#ffffff" }}
        >
          Publish your book. Find your readers.
        </h1>
        <p
          className="mx-auto mt-3 max-w-lg text-lg"
          style={{ color: "rgba(255, 255, 255, 0.8)" }}
        >
          Publish and sell your books. Discover new voices. Librum brings
          Albanian-language authors and readers together in one digital
          bookstore.
        </p>
        <div
          className="mt-6 flex flex-wrap justify-center"
          style={{ gap: "0.75rem" }}
        >
          <Link
            href="/signup?role=author"
            className="rounded-lg px-5 py-2.5 text-sm font-medium"
            style={{ backgroundColor: "#ffffff", color: "#6a5cf0" }}
          >
            Publish your book
          </Link>
          <Link
            href="/bookstore"
            className="rounded-lg px-5 py-2.5 text-sm font-medium"
            style={{
              color: "#ffffff",
              border: "1px solid rgba(255, 255, 255, 0.4)",
            }}
          >
            Explore books
          </Link>
        </div>
      </div>

      {covers.length > 0 && (
        <div style={{ overflowX: "auto", paddingBottom: "2rem" }}>
          <div
            style={{
              display: "flex",
              gap: "1rem",
              width: "max-content",
              padding: "0 1.5rem",
              margin: "0 auto",
            }}
          >
            {covers.map((cover) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={cover.id}
                src={cover.url}
                alt=""
                style={{
                  width: "9rem",
                  flexShrink: 0,
                  aspectRatio: "2 / 3",
                  objectFit: "cover",
                  borderRadius: "0.5rem",
                  boxShadow: "0 10px 25px rgba(0, 0, 0, 0.25)",
                }}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ============================================================
// Section 2 — Book Discovery
// ============================================================

function BookDiscoverySection({
  books,
  supabase,
}: {
  books: BookWithAuthor[];
  supabase: SupabaseClient;
}) {
  if (books.length === 0) return null;

  return (
    <section style={{ marginTop: "3.5rem" }}>
      <h2 className="font-serif text-2xl font-bold">
        Explore the latest releases
      </h2>
      <p className="mt-1 text-sm text-muted">
        Freshly published books from independent authors.
      </p>
      {/* BookShelf renders its own heading + top margin, meant for
          standalone use on /bookstore — here the heading above already
          covers that job, so title is left empty and the .homepage-shelf
          scope (see globals.css) hides the now-empty <h2> and neutralizes
          the duplicate top margin, plus slims the scrollbar and adds
          right-edge padding so the last cover isn't clipped. All of this
          is scoped to this wrapper class only — /bookstore's BookShelf is
          untouched. */}
      <div className="homepage-shelf" style={{ marginTop: "0.75rem" }}>
        <BookShelf title="" books={books} supabase={supabase} />
      </div>
      <Link
        href="/bookstore"
        className="mt-3 inline-block text-sm font-medium text-primary hover:underline"
      >
        Explore all books &rarr;
      </Link>
    </section>
  );
}

// ============================================================
// Section 3 — Author Value Proposition
// ============================================================

const AUTHOR_CHECKLIST = [
  "Simple publishing",
  "Direct access to Albanian-language readers",
  `Keep ${100 - PLATFORM_FEE_PERCENT}% of every sale`,
  "Control your book, price and listing",
  "Sales dashboard with revenue and units sold",
];

function AuthorValueSection() {
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: "3rem",
        marginTop: "3.5rem",
        alignItems: "center",
      }}
    >
      <div>
        <h2 className="font-serif text-3xl font-bold">
          Publish on your terms.
        </h2>
        <p className="mt-3 text-foreground/90">
          Librum gives independent authors a direct path to readers.
          Publish on your terms, control your book and pricing, and keep{" "}
          {100 - PLATFORM_FEE_PERCENT}% of every sale.
        </p>
        <Link
          href="/pricing"
          className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
        >
          See how much you could earn &rarr;
        </Link>
      </div>

      <ul style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}>
        {AUTHOR_CHECKLIST.map((item) => (
          <li key={item} className="flex items-center gap-3 text-sm">
            <IconCheck
              className="text-primary"
              style={{ width: "1.125rem", height: "1.125rem", flexShrink: 0 }}
            />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ============================================================
// Section 4 — How It Works
// ============================================================

const PUBLISHING_STEPS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Upload your book",
    body: "Add your EPUB manuscript and cover.",
    icon: IconUpload,
  },
  {
    title: "Prepare your listing",
    body: "Add your title, description, genre and price.",
    icon: IconBookOpen,
  },
  {
    title: "Publish",
    body: "Review everything, then go live.",
    icon: IconBolt,
  },
  {
    title: "Sell and track your results",
    body: "Track revenue and units sold from your dashboard.",
    icon: IconChart,
  },
];

function HowItWorksSection() {
  return (
    <section style={{ marginTop: "3.5rem" }}>
      <h2 className="text-center font-serif text-2xl font-bold">
        How self-publishing works
      </h2>
      <ol
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "2rem",
          marginTop: "2rem",
        }}
      >
        {PUBLISHING_STEPS.map((step, i) => (
          <li key={step.title} className="text-center">
            <IconBadge icon={step.icon} />
            <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-primary">
              Step {i + 1}
            </p>
            <h3 className="mt-1 font-serif text-lg font-bold">
              {step.title}
            </h3>
            <p className="mt-1 text-sm text-foreground/90">{step.body}</p>
          </li>
        ))}
      </ol>
      <div className="mt-6 flex flex-wrap justify-center gap-6">
        <Link
          href="/how-it-works"
          className="text-sm font-medium text-primary hover:underline"
        >
          Read the full guide &rarr;
        </Link>
        <Link
          href="/pricing"
          className="text-sm font-medium text-primary hover:underline"
        >
          Find out how much you can make &rarr;
        </Link>
      </div>
    </section>
  );
}

function IconBadge({ icon: Icon }: { icon: Icon }) {
  return (
    <div
      style={{
        width: "5.5rem",
        height: "5.5rem",
        borderRadius: "50%",
        backgroundColor: "rgba(106, 92, 240, 0.1)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        margin: "0 auto",
      }}
    >
      <Icon
        className="text-primary"
        style={{ width: "2.25rem", height: "2.25rem" }}
      />
    </div>
  );
}

// ============================================================
// Section 5 — Reader Experience
// ============================================================

// An intentional, overlapping composition of real cover art — subtle
// overlap, varied vertical position, and modest scale differences
// rather than a floating grid — reusing the same covers already
// fetched for the hero strip, no separate query.
const COLLAGE_LAYOUT = [
  { top: "2.5rem", left: "0rem", width: "7.5rem", rotate: -3, z: 1 },
  { top: "0rem", left: "5.25rem", width: "9.5rem", rotate: 0, z: 3 },
  { top: "3rem", left: "11.5rem", width: "7rem", rotate: 3, z: 2 },
];

function CoverCollage({ covers }: { covers: { id: string; url: string }[] }) {
  const shown = covers.slice(0, COLLAGE_LAYOUT.length);
  if (shown.length === 0) return null;

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        maxWidth: "19rem",
        height: "17.5rem",
        margin: "0 auto",
      }}
    >
      {shown.map((cover, i) => {
        const layout = COLLAGE_LAYOUT[i];
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={cover.id}
            src={cover.url}
            alt=""
            className="aspect-[2/3] rounded-lg object-cover shadow-lg"
            style={{
              position: "absolute",
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

function ReaderExperienceSection({
  covers,
}: {
  covers: { id: string; url: string }[];
}) {
  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: "2.5rem",
        marginTop: "3.5rem",
        alignItems: "center",
      }}
    >
      <div style={{ order: 2 }}>
        <h2 className="font-serif text-3xl font-bold">
          A bookstore, not just a platform.
        </h2>
        <p className="mt-3 text-foreground/90">
          Discover ebooks by genre or keyword, preview a sample before you
          buy, and own what you purchase — a DRM-free file you can read
          anywhere, revisit anytime from your library.
        </p>
        <Link
          href="/bookstore"
          className="mt-4 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Browse the bookstore
        </Link>
      </div>

      <div style={{ order: 1 }}>
        <CoverCollage covers={covers} />
      </div>
    </section>
  );
}

// ============================================================
// Section 6 — 80% Author Earnings
// ============================================================

function EarningsSection() {
  return (
    <section style={{ backgroundColor: "#fdf0e3", marginTop: "3.5rem" }}>
      <div
        className="mx-auto w-full max-w-2xl px-4 text-center sm:px-6"
        style={{ paddingTop: "4rem", paddingBottom: "4rem" }}
      >
        <h2 className="font-serif text-4xl font-bold sm:text-5xl">
          You keep {100 - PLATFORM_FEE_PERCENT}% of every sale.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-foreground/90">
          You set the price. You keep {100 - PLATFORM_FEE_PERCENT}% of
          every sale. Librum&apos;s platform share is {PLATFORM_FEE_PERCENT}%.
        </p>
        <Link
          href="/pricing"
          className="mt-6 inline-block text-sm font-medium text-primary hover:underline"
        >
          Try the earnings calculator &rarr;
        </Link>
      </div>
    </section>
  );
}

// ============================================================
// Section 7 — Final Dual CTA
// ============================================================

function FinalCtaSection() {
  return (
    <section style={{ backgroundColor: "#e9eff8" }}>
      <div
        className="mx-auto w-full max-w-2xl px-4 text-center sm:px-6"
        style={{ paddingTop: "4rem", paddingBottom: "4rem" }}
      >
        <h2 className="font-serif text-3xl font-bold sm:text-4xl">
          Your next chapter starts here.
        </h2>
        <p className="mx-auto mt-3 max-w-md text-foreground/90">
          Whether you&apos;re here to publish or to read, Librum is ready
          when you are.
        </p>
        <div
          className="mt-6 flex flex-wrap justify-center"
          style={{ gap: "0.75rem" }}
        >
          <Link
            href="/signup?role=author"
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Publish your book
          </Link>
          <Link
            href="/bookstore"
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-medium hover:bg-surface-hover"
          >
            Explore books
          </Link>
        </div>
      </div>
    </section>
  );
}
