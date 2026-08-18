import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import {
  IconUpload,
  IconBolt,
  IconBookOpen,
  IconBank,
  IconChart,
  IconTag,
  IconLayers,
  IconShield,
  IconCheck,
  IconGlobe,
} from "@/components/icons";
import type { Book } from "@/lib/types";
import type { ComponentType, CSSProperties } from "react";

type Icon = ComponentType<{ className?: string; style?: CSSProperties }>;
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

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

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ account?: string }>;
}) {
  const { account } = await searchParams;
  const supabase = await createClient();
  const heroCovers = await fetchHeroCovers(supabase);

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

      <div style={{ backgroundColor: "#e9eff8" }}>
        <div
          className="mx-auto w-full max-w-5xl px-4 sm:px-6"
          style={{ paddingTop: "4rem", paddingBottom: "5rem" }}
        >
          <AuthorPitch />
        </div>
      </div>
    </main>
  );
}

const PUBLISHING_STEPS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Upload your book",
    body: "Add your EPUB manuscript, a cover, a description, and a price. Takes a few minutes.",
    icon: IconUpload,
  },
  {
    title: "Publish instantly",
    body: "No submission queue, no approval wait — your book goes live the moment you hit publish.",
    icon: IconBolt,
  },
  {
    title: "Readers buy directly",
    body: "Secure checkout, real DRM-free EPUB files — readers get a book they actually own.",
    icon: IconBookOpen,
  },
  {
    title: "Get paid automatically",
    body: `Every sale splits instantly — you keep ${100 - PLATFORM_FEE_PERCENT}%, paid straight to your bank account.`,
    icon: IconBank,
  },
];

const AUTHOR_STRIP = [
  "No setup fees",
  "No minimum sales",
  `Keep ${100 - PLATFORM_FEE_PERCENT}% of every sale`,
  "Payouts via Stripe",
];

const WHY_LIBRUM: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Publish in minutes",
    body: "No submission queue, no waiting on approval — upload your book and it's live the moment you hit publish.",
    icon: IconBolt,
  },
  {
    title: "You control your earnings",
    body: `Set your own price, run your own discounts, and keep ${100 - PLATFORM_FEE_PERCENT}% of every sale — paid straight to your bank account.`,
    icon: IconBank,
  },
  {
    title: "Reach readers everywhere",
    body: "Your book page is public and shareable from day one — no separate storefront to set up.",
    icon: IconGlobe,
  },
];

const PUBLISHING_TOOLS: { title: string; body: string; icon: Icon }[] = [
  {
    title: "Sales dashboard",
    body: "Revenue, units sold, and a 14-day chart — broken down per book, so you know what's working.",
    icon: IconChart,
  },
  {
    title: "Discount codes",
    body: "Run a percentage- or dollar-off promo on any book, with an optional expiry date.",
    icon: IconTag,
  },
  {
    title: "Series",
    body: "Group your books in reading order — shown right on each book's page, linking readers to the next one.",
    icon: IconLayers,
  },
  {
    title: "Watermarked downloads",
    body: "Every sale is stamped with the buyer's email — lightweight anti-piracy, no DRM, no restrictions for readers.",
    icon: IconShield,
  },
];

// A staggered, slightly-rotated grid of real cover art from books already
// published on the platform — used as hero imagery instead of stock
// photography, which this environment has no way to fetch.
// Full-bleed, edge-to-edge hero band — deliberately escapes the site's
// usual max-w-5xl content column so it reads as a distinct "front door"
// section, in the mold of Lulu's own homepage.
function HeroSection({ covers }: { covers: { id: string; url: string }[] }) {
  return (
    <section style={{ backgroundColor: "#6a5cf0" }}>
      <div
        className="mx-auto w-full max-w-2xl px-4 text-center sm:px-6"
        style={{ paddingTop: "5rem", paddingBottom: "3rem" }}
      >
        <h1
          className="font-serif text-4xl font-semibold sm:text-6xl"
          style={{ color: "#ffffff" }}
        >
          Write. Publish. Profit.
        </h1>
        <p
          className="mx-auto mt-4 max-w-lg text-lg"
          style={{ color: "rgba(255, 255, 255, 0.8)" }}
        >
          Upload an EPUB, set your price, and go live today — Librum handles
          checkout, delivery, and payouts.
        </p>
        <div
          className="mt-8 flex flex-wrap justify-center"
          style={{ gap: "0.75rem" }}
        >
          <Link
            href="/signup?role=author"
            className="rounded-lg px-5 py-2.5 text-sm font-medium"
            style={{ backgroundColor: "#ffffff", color: "#6a5cf0" }}
          >
            Publish your book
          </Link>
        </div>
      </div>

      {covers.length > 0 && (
        <div style={{ overflowX: "auto", paddingBottom: "3rem" }}>
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

function AuthorPitch() {
  return (
    <>
      <div
        className="flex flex-wrap justify-center rounded-lg border border-border bg-surface py-5 text-center text-sm font-medium shadow-sm"
        style={{ gap: "1rem 3rem", marginTop: "2.5rem" }}
      >
        {AUTHOR_STRIP.map((item) => (
          <span key={item} className="flex items-center gap-2">
            <IconCheck
              className="text-primary"
              style={{ width: "1rem", height: "1rem" }}
            />
            {item}
          </span>
        ))}
      </div>

      <section style={{ marginTop: "5rem" }}>
        <h2 className="text-center font-serif text-2xl font-semibold">
          Why Librum?
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "2.5rem",
            marginTop: "2rem",
          }}
        >
          {WHY_LIBRUM.map((item) => (
            <div key={item.title} className="text-center">
              <IconBadge icon={item.icon} />
              <h3 className="mt-4 font-serif text-lg font-semibold">
                {item.title}
              </h3>
              <p className="mt-1 text-sm text-foreground/90">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section style={{ marginTop: "5rem" }}>
        <h2 className="text-center font-serif text-2xl font-semibold">
          How self-publishing works
        </h2>
        <ol
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "2.5rem",
            marginTop: "2rem",
          }}
        >
          {PUBLISHING_STEPS.map((step, i) => (
            <li key={step.title} className="text-center">
              <IconBadge icon={step.icon} />
              <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-primary">
                Step {i + 1}
              </p>
              <h3 className="mt-1 font-serif text-lg font-semibold">
                {step.title}
              </h3>
              <p className="mt-1 text-sm text-foreground/90">{step.body}</p>
            </li>
          ))}
        </ol>
        <div
          className="mt-6 flex flex-wrap justify-center gap-6"
        >
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

      <section style={{ marginTop: "5rem" }}>
        <h2 className="text-center font-serif text-2xl font-semibold">
          Everything you need to sell your book
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            gap: "2.5rem",
            marginTop: "2rem",
          }}
        >
          {PUBLISHING_TOOLS.map((tool) => (
            <div key={tool.title} className="text-center">
              <IconBadge icon={tool.icon} />
              <h3 className="mt-4 font-serif text-lg font-semibold">
                {tool.title}
              </h3>
              <p className="mt-1 text-sm text-foreground/90">{tool.body}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

// A large circular icon badge, matching the sizing/proportion of Lulu's
// own feature-grid icons rather than a small inline glyph.
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
