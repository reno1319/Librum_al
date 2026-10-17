import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { resolveHomepageCta, computeAuthorSharePercent, type HomepageCta } from "@/lib/homepage";
import { Alert } from "@/components/ui/alert";
import { IconCheck } from "@/components/icons";
import { resolvePublicAuthorName } from "@/lib/author-name";
import type { Book, Profile } from "@/lib/types";
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
//
// REDESIGN STEP 2 (A2 "Library Green & Brass"): same sections, order,
// data and words. The hero and the closing CTA are dark green bands
// with cream text and a brass button; the sections between alternate
// cream and white. Brass is a fill or a rule only (never text on cream:
// 1.9:1). Large serif headings are regular weight; small headings are
// bold sans in green, as in the mockup.
// Standalone text links are underlined at rest, because green link text
// next to near-black body text is only 1.29:1 apart (step 1 audit, C1).

// LIBRUM 2.0 SEO-1: `absolute` deliberately opts this one page out of the
// root layout's "%s | Librum" title template -- the homepage's own title
// already IS the full brand title, so applying the template on top of it
// would produce "Librum — Self-Publish Your Ebook | Librum".
export const metadata: Metadata = {
  title: { absolute: "Librum — Self-Publish Your Ebook" },
  description:
    "The self-publishing platform built for Albanian-language authors. Publish independently, set your own price, and reach readers through Librum.",
};

// Brass call-to-action button (square-cornered, like the mockup) for the green bands: brass fill with green
// text (5.85:1), cream fill on hover (11.1:1). Kept page-local so the
// shared Button primitive is unchanged in this step.
const BRASS_CTA_CLASSES =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-[3px] bg-accent px-7 py-4 text-base font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground";

// Underlined at rest, thicker underline on hover (C1).
const TEXT_LINK_CLASSES =
  "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";

// REDESIGN STEP 2: the A2 mockup's section frame -- a wide container,
// generous vertical rhythm and left-aligned regular-weight serif
// headings in green. Every section between the hero and the closing band
// uses these, alternating cream and white backgrounds.
const SECTION_CONTAINER = "mx-auto w-full max-w-wide px-4 py-12 sm:px-6 md:py-16";
const SECTION_HEADING = "font-serif text-3xl font-normal text-primary sm:text-4xl lg:text-[2.625rem]";
// Italic dark-brass numerals, as in the mockup (4.43:1 on cream and
// white; large text, so 3:1 applies).
const NUMERAL_CLASSES = "block font-serif text-[1.75rem] italic leading-none text-[#8a6d12]";
// Outline button on the green hero, beside the brass one.
const OUTLINE_ON_DARK_CTA_CLASSES =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-[3px] border border-primary-foreground/40 px-7 py-4 text-base font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover";

// Lower-case roman numerals for the three "Why Librum" pillars.
const PILLAR_NUMERALS = ["i.", "ii.", "iii."];

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// LIBRUM 2.0 UI-3: fetches the covers "Published with Librum" shows as
// proof. Capped at 8, matching the locked "fetch no more than 8
// published covers" instruction. GLOBAL VISUAL POLISH 1: the hero no
// longer shows any covers at all (see section 4 of the approved design
// -- covers belong to "Published with Librum" only, never the hero), so
// every fetched cover is available to that one section; no split is
// needed any more. (REDESIGN STEP 2 brings covers back to the hero as a
// shelf, per Renato's chosen A2 mockup -- see HeroShelf -- reusing these
// same fetched covers, still one query.) `title` is now selected alongside `id`/`cover_path`
// -- covers became real links to /books/{id} in this pass, and a linked,
// otherwise-decorative cover image needs SOME accessible name (see
// PublishedWithLibrumSection's aria-label) -- this is the same single
// query, extended by one scalar column, not a new query.
const MAX_HOMEPAGE_COVERS = 8;

// ALL-WIRING-2: `.not("price_all", "is", null)` joins the two filters
// already here. This section links each cover to its book's detail
// page, so it is a public listing of the storefront's catalog even
// though it renders no price -- and a book with no authored ALL price
// is not part of that catalog until its author sets one. Consequence
// worth stating plainly rather than discovering later: while every
// published book is unpriced, this section renders nothing at all.
async function fetchPublishedCovers(supabase: SupabaseClient) {
  const { data } = await supabase
    .from("books")
    // REDESIGN STEP 2: the hero shelf writes each book's author on its
    // spine, through the public author view (never raw display_name),
    // the same alias pattern the bookstore uses.
    // r8: genre and description too, for the three-book showcase in
    // "Published with Librum" (each book's own data, no site copy).
    .select("id, title, cover_path, genre, description, profiles:public_author_profiles(public_author_name)")
    .eq("status", "published")
    .not("price_all", "is", null)
    .not("cover_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_HOMEPAGE_COVERS)
    .returns<
      (Pick<Book, "id" | "title" | "cover_path" | "genre" | "description"> & {
        profiles: Pick<Profile, "public_author_name"> | null;
      })[]
    >();

  return (data ?? []).map((b) => ({
    id: b.id,
    title: b.title,
    author: resolvePublicAuthorName(b.profiles),
    genre: b.genre,
    description: b.description,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data.publicUrl,
  }));
}

type Cover = {
  id: string;
  title: string;
  author: string | null;
  genre: string | null;
  description: string | null;
  url: string;
};

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

      <HeroSection cta={cta.hero} covers={covers} />
      <WhyLibrumSection />
      <PublishInFourStepsSection />
      <EarningsSection />
      {covers.length > 0 && <PublishedWithLibrumSection books={pickFeaturedBooks(covers)} />}
      {cta.final && <FinalCtaSection cta={cta.final} />}
    </main>
  );
}

// ============================================================
// Section 1 — Hero: compact editorial two-column layout (author-only:
// one CTA, no reader path). Dark green band with cream text (REDESIGN
// STEP 2; it replaces the pale tint that barely showed against the page).
// REDESIGN STEP 2: the right column is a shelf of real published books,
// as in Renato's chosen A2 mockup, once at least HERO_SHELF_SIZE exist;
// with fewer it falls back to the photograph (HeroMedia), so the live
// site never shows a half-empty shelf or invented books.
// ============================================================

function HeroSection({ cta, covers }: { cta: HomepageCta | null; covers: Cover[] }) {
  const authorShare = computeAuthorSharePercent();
  const proofPoints = [
    `${authorShare}% author share`,
    "You set the price",
    "No setup fee",
    "No monthly subscription",
  ];
  // On desktop the shelf stands on the band's bottom edge, as in the
  // mockup; the photograph stays vertically centred.
  const showShelf = covers.length >= HERO_SHELF_SIZE;

  return (
    <section className="bg-primary text-primary-foreground">
      <div
        className={`mx-auto w-full max-w-wide px-4 py-10 sm:px-6 ${showShelf ? "lg:pt-14 lg:pb-0" : "lg:py-14"}`}
      >
        <div
          className={`grid gap-10 lg:grid-cols-[55fr_45fr] lg:gap-12 ${showShelf ? "lg:items-end" : "lg:items-center"}`}
        >
          <div className={`max-w-xl ${showShelf ? "lg:pb-14" : ""}`}>
            <div className="flex items-center gap-3">
              <span aria-hidden="true" className="block h-px w-10 bg-accent" />
              <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-accent">
                Self-publishing for Albanian-language authors
              </p>
            </div>
            <h1 className="mt-5 font-serif text-4xl font-normal leading-[1.1] sm:text-5xl lg:text-[3.5rem]">
              Publish your book.
              <br />
              <span className="italic text-accent">Your way.</span>
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-primary-foreground/85 md:text-lg">
              The self-publishing platform built for Albanian-language
              authors. Publish independently, set your own price, and reach
              readers through Librum.
            </p>

            {/* REDESIGN STEP 2: the mockup's two hero buttons. The
                second is the existing "Read the full guide" link, moved
                up here from "Publish in four steps". */}
            <div className="mt-8 flex flex-wrap gap-3">
              {cta && (
                <Link href={cta.href} className={BRASS_CTA_CLASSES}>
                  {cta.label}
                </Link>
              )}
              <Link href="/how-it-works" className={OUTLINE_ON_DARK_CTA_CLASSES}>
                Read the full guide &rarr;
              </Link>
            </div>

            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2.5">
              {proofPoints.map((point) => (
                <li
                  key={point}
                  className="flex items-center gap-2 text-sm font-medium whitespace-nowrap text-primary-foreground"
                >
                  <IconCheck className="size-4 shrink-0 text-accent" />
                  {point}
                </li>
              ))}
            </ul>
          </div>

          {showShelf ? (
            <HeroShelf covers={covers.slice(0, HERO_SHELF_SIZE)} />
          ) : (
            <HeroMedia />
          )}
        </div>
      </div>
    </section>
  );
}

// REDESIGN STEP 2: the A2 mockup's bookshelf -- five books drawn as
// coloured spines on a wooden shelf, bottom-aligned, at the mockup's own
// heights (240-300px on desktop, scaled down on smaller screens), each
// with its real title at the top and its real author at the bottom,
// as the mockup draws them. The colour pairs are the mockup's; every text
// pair is at least 5.8:1. Books are real published books with the same
// links as "Published with Librum", never invented ones.
//
// Titles must wrap between whole words (step 2 audit B1: "Durrë / sit"
// at 17px in a ~60px spine). Each spine is a size container and the
// title size follows the spine's own width: 22cqi (about the mockup's
// 15px at its 74px spine), made smaller when the title's longest word
// would not fit (measured Libre Caslon letters average at most ~0.55em,
// so 0.6em per letter is allowed), between 8.5px and 17px, with slim
// side padding. Measured: words up to 11 letters stay whole at 360,
// 768, 1024 and 1280px, and 12-letter words from 768px up; only a longer
// word on a narrow phone can still wrap, hyphenated where the browser
// has Albanian hyphenation (lang="sq"), else broken as a last resort.
function spineTitleFontSize(title: string): string {
  const longestWord = Math.max(1, ...title.split(/\s+/).map((word) => word.length));
  const fitCqi = Math.min(22, 100 / (longestWord * 0.6));
  return `clamp(0.53125rem, ${fitCqi.toFixed(2)}cqi, 1.0625rem)`;
}
const HERO_SHELF_SIZE = 5;
// Literal class strings so Tailwind generates them.
// REDESIGN STEP 2 r6 (Renato: bigger, five books, a library feel):
// about a third taller than the mockup so the shelf fills the hero
// beside the text.
const HERO_SHELF_SPINES = [
  "h-[185px] sm:h-[250px] lg:h-[340px] bg-[#7a2e2e] text-[#f6e7d8]",
  "h-[215px] sm:h-[290px] lg:h-[390px] bg-[#f7f3ea] text-[#1e3a32]",
  "h-[172px] sm:h-[232px] lg:h-[312px] bg-[#d4af37] text-[#1e3a32]",
  "h-[208px] sm:h-[280px] lg:h-[378px] bg-[#2b4f7a] text-white",
  "h-[180px] sm:h-[242px] lg:h-[326px] bg-[#e8dcc4] text-[#2a2a2a]",
];
// Library-binding details, decorative: a soft shade at both edges so the
// spine reads round (at most 10% black, so every text pair keeps at
// least 4.5:1), and thin double bands in the spine's own text colour
// above the title and above the author, like gilt tooling.
const SPINE_SHADE_CLASSES =
  "bg-[linear-gradient(90deg,rgba(0,0,0,0.1),rgba(0,0,0,0)_22%,rgba(255,255,255,0.06)_45%,rgba(0,0,0,0)_70%,rgba(0,0,0,0.1))]";
const SPINE_BAND_CLASSES = "block h-[4px] shrink-0 border-y border-current opacity-50";

function HeroShelf({ covers }: { covers: Cover[] }) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-[520px] lg:mx-0 lg:max-w-none">
      <div className="flex items-end gap-1 px-1 sm:gap-1.5 sm:px-3">
        {covers.map((cover, i) => (
          <Link
            key={cover.id}
            href={`/books/${cover.id}`}
            aria-label={`View ${cover.title} on Librum`}
            className={`@container focus-ring flex min-w-0 flex-1 flex-col gap-2 overflow-hidden rounded-t-[3px] px-1 py-2.5 shadow-[0_-2px_8px_rgba(0,0,0,0.25)] transition-transform duration-150 hover:-translate-y-1 motion-reduce:transition-none motion-reduce:hover:translate-y-0 sm:gap-3 sm:py-4 xl:px-2 ${SPINE_SHADE_CLASSES} ${HERO_SHELF_SPINES[i % HERO_SHELF_SPINES.length]}`}
          >
            <span aria-hidden="true" className={SPINE_BAND_CLASSES} />
            <span
              lang="sq"
              className="line-clamp-6 font-serif leading-[1.15] hyphens-auto break-words"
              style={{ fontSize: spineTitleFontSize(cover.title) }}
            >
              {cover.title}
            </span>
            <span aria-hidden="true" className={`mt-auto ${SPINE_BAND_CLASSES}`} />
            {cover.author && (
              <span
                lang="sq"
                className="line-clamp-2 text-[0.6875rem] leading-tight tracking-[0.04em] hyphens-auto break-words uppercase sm:text-xs"
              >
                {cover.author}
              </span>
            )}
          </Link>
        ))}
      </div>
      {/* Wooden shelf, the mockup's own brown (#6b4f2a), with a lighter
          top edge and a shadow below so it has depth; decorative. */}
      <div
        aria-hidden="true"
        className="h-3.5 border-t-2 border-[#8a6a3c] bg-[#6b4f2a] shadow-[0_6px_12px_rgba(0,0,0,0.35)]"
      />
    </div>
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
      {/* REDESIGN STEP 2: framed like a print on the green band -- a thin
          brass rule offset behind the photograph. Decorative only. */}
      <div className="relative pr-3 pb-3">
        <div
          aria-hidden="true"
          className="absolute top-3 right-0 bottom-0 left-3 rounded-lg border border-accent/70"
        />
        <div className="relative aspect-video overflow-hidden rounded-lg shadow-md lg:aspect-[4/5]">
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
      <div className={SECTION_CONTAINER}>
        <h2 className={SECTION_HEADING}>Why Librum</h2>
        <p className="mt-3 max-w-xl text-foreground/80">
          A direct way for Albanian-language writers to publish
          professionally and reach readers.
        </p>

        <div className="mt-8 grid gap-8 sm:grid-cols-3">
          {WHY_LIBRUM_PILLARS.map((pillar, i) => (
            <div key={pillar.heading}>
              <span className={NUMERAL_CLASSES}>
                {PILLAR_NUMERALS[i]}
              </span>
              <h3 className="mt-2 text-xl font-bold text-primary">{pillar.heading}</h3>
              <p className="mt-2 leading-relaxed text-muted">
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
// each step is now a 01→02→03→04 progression (REDESIGN STEP 2 r7:
// without the mini mockups that used to sit under each step).
// ============================================================

const PUBLISHING_STEPS: { title: string; body: string }[] = [
  {
    title: "Prepare your manuscript",
    body: "Have your finished book ready as an EPUB file — or a DOCX file, which Librum converts into an EPUB for you — along with a cover image.",
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
    body: "Paid publishing and author payout setup have not launched yet. Authors can continue to publish free books while Librum completes its payment and payout systems.",
  },
];

function PublishInFourStepsSection() {
  return (
    <section className="border-y border-border bg-surface">
      <div className={SECTION_CONTAINER}>
        <h2 className={SECTION_HEADING}>Publish in four steps</h2>
        {/* Each step spans three shared grid rows (numeral, heading,
            text), so the four steps line up row by row however long their
            headings are. REDESIGN STEP 2 r7 (Renato's card "Remove
            drawings"): the small illustrative panels under each step are
            gone; each step is its number, heading and text. */}
        <ol className="mt-8 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
          {PUBLISHING_STEPS.map((step, i) => (
            <li
              key={step.title}
              className="grid content-start gap-y-2 sm:row-span-3 sm:grid-rows-subgrid"
            >
              <span className={NUMERAL_CLASSES}>{String(i + 1).padStart(2, "0")}</span>
              <h3 className="text-lg font-bold text-primary">{step.title}</h3>
              <p className="text-base leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ============================================================
// Section 4 — Earnings: one coherent proposition instead of a bare
// percentage. REDESIGN STEP 2: a cream section in the mockup's frame;
// the oversized background numeral (pure texture) is gone.
// ============================================================

function EarningsSection() {
  const authorShare = computeAuthorSharePercent();

  return (
    <section className="bg-background">
      <div className={`${SECTION_CONTAINER} grid gap-6 sm:grid-cols-[auto_1fr] sm:items-center sm:gap-14`}>
        <div>
          <span className="font-serif text-6xl font-normal text-primary sm:text-7xl lg:text-8xl">{authorShare}%</span>
          <p className="mt-1 text-sm font-medium uppercase tracking-wide text-muted">
            Author share
          </p>
        </div>
        <div className="sm:border-l sm:border-accent sm:pl-14">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">Earnings</p>
          <h2 className={`mt-2 ${SECTION_HEADING}`}>
            Keep more of every eligible sale.
          </h2>
          <p className="mt-3 leading-relaxed text-foreground/90">
            Librum keeps a {PLATFORM_FEE_PERCENT}% platform fee. No setup
            fee. No monthly subscription.
          </p>
          {/* r9: moved here from the deleted tools section ("Track your
              sales"), word for word. */}
          <p className="mt-2 leading-relaxed text-foreground/90">
            Follow units sold and revenue from your author dashboard.
          </p>
          <Link href="/pricing" className={`${TEXT_LINK_CLASSES} mt-4 inline-block`}>
            See how earnings work &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 5 — Published with Librum: real published covers as proof.
// REDESIGN STEP 2: a white section in the mockup's frame (r8: three
// featured books, see below). Non-commerce: books link to /books/{id} (proof that
// Librum books reach the public marketplace) but never show price/Buy/
// wishlist/rating.
// ============================================================

// REDESIGN STEP 2 r8 (Renato's card "Three featured"): a small curated
// showcase instead of a row of covers -- three books (see
// pickFeaturedBooks for which), each
// with its cover, title, author, genre and the first lines of its
// description, all the book's own data. A quiet grid, no shelf: one
// column with the cover beside the text on phones and tablets, three
// columns from lg up. Each book is one link to its page.
const FEATURED_BOOK_COUNT = 3;

// r10 (Renato's card "Skip hero books"): when the hero shelf shows, it
// takes the 5 newest books, so the showcase takes the next ones (6-8) and
// fills any gap with hero books, newest first. Without the shelf (fewer
// than HERO_SHELF_SIZE books) the hero shows the photo, so the showcase
// takes the newest books. Never more than FEATURED_BOOK_COUNT, no book
// twice.
function pickFeaturedBooks(covers: Cover[]): Cover[] {
  if (covers.length < HERO_SHELF_SIZE) return covers.slice(0, FEATURED_BOOK_COUNT);
  const afterShelf = covers.slice(HERO_SHELF_SIZE, HERO_SHELF_SIZE + FEATURED_BOOK_COUNT);
  const fill = covers.slice(0, FEATURED_BOOK_COUNT - afterShelf.length);
  return [...afterShelf, ...fill];
}

function PublishedWithLibrumSection({ books }: { books: Cover[] }) {
  return (
    <section className="border-y border-border bg-surface">
      <div className={SECTION_CONTAINER}>
        <h2 className={SECTION_HEADING}>Published with Librum</h2>
        <p className="mt-3 max-w-md text-muted">
          Books brought to readers by independent Librum authors.
        </p>

        <ul className="mt-8 grid gap-8 lg:grid-cols-3 lg:gap-10">
          {books.map((book) => (
            <li key={book.id}>
              <Link
                href={`/books/${book.id}`}
                aria-label={`View ${book.title} on Librum`}
                className="focus-ring group/book flex gap-5 rounded-[3px]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={book.url}
                  alt=""
                  loading="lazy"
                  className="aspect-[2/3] w-28 shrink-0 self-start rounded-[3px] object-cover shadow-[0_8px_16px_-8px_rgba(0,0,0,0.45)] transition-transform duration-150 group-hover/book:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover/book:translate-y-0 sm:w-32 xl:w-36"
                />
                <div className="min-w-0">
                  {book.genre && (
                    <p className="text-xs font-semibold tracking-[0.08em] text-primary uppercase">
                      {book.genre}
                    </p>
                  )}
                  <h3
                    lang="sq"
                    className="mt-1.5 line-clamp-3 font-serif text-xl leading-snug text-primary group-hover/book:underline"
                  >
                    {book.title}
                  </h3>
                  {book.author && (
                    <p lang="sq" className="mt-1 text-sm text-foreground/80">
                      {book.author}
                    </p>
                  )}
                  {book.description && (
                    <p lang="sq" className="mt-3 line-clamp-4 text-[0.9375rem] leading-relaxed text-muted">
                      {book.description}
                    </p>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-8">
          <Link href="/bookstore" className={TEXT_LINK_CLASSES}>
            See published books &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 6 — Final CTA. REDESIGN STEP 2 r9 (Renato, 13:09Z: "delete,
// but put Track your sales somewhere else"): the "Simple to start. Built
// for the long run." tools section is gone -- its price and payout
// columns repeated the hero, "Why Librum" and step 04 -- and its one
// unique line, about following sales, now sits in the Earnings section.
// ============================================================

function FinalCtaSection({ cta }: { cta: HomepageCta }) {
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
