import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { resolveHomepageCta, computeAuthorSharePercent, type HomepageCta } from "@/lib/homepage";
import { Alert } from "@/components/ui/alert";
import { IconCheck } from "@/components/icons";
import { resolveBookByline } from "@/lib/book-byline";
import type { PenNameRef } from "@/lib/pen-names";
import { getPublicHomeSlots } from "@/lib/home-picks";
import { HOME_SLOT_COUNT, pickShowcaseBooks, resolveHomeFan, type FanCover } from "@/lib/home-picks-logic";
import { HomeCoverFan } from "@/components/home-cover-fan";
import type { PublicBook } from "@/lib/types";
import {
  BRASS_CTA_CLASSES,
  ClosingCtaBand,
  Eyebrow,
  NUMERAL_CLASSES,
  SECTION_CONTAINER,
  SECTION_HEADING,
  TEXT_LINK_CLASSES,
} from "@/components/page-bands";
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
  title: { absolute: "Librum — Vetëbotim për libra elektronikë" },
  description:
    "Platforma e vetëbotimit e ndërtuar për autorët që shkruajnë shqip. Botoni në mënyrë të pavarur, vendosni vetë çmimin dhe arrini te lexuesit përmes Librum.",
};

// BRASS_CTA_CLASSES, TEXT_LINK_CLASSES, the section frame
// (SECTION_CONTAINER, SECTION_HEADING), NUMERAL_CLASSES, the eyebrow and
// the closing band live in @/components/page-bands (AUTHOR PAGES
// REDESIGN), shared with the inner author pages.

// Outline button on the green hero, beside the brass one. PHONE PASS
// (D1): 48px tall on phones, like BRASS_CTA_CLASSES.
const OUTLINE_ON_DARK_CTA_CLASSES =
  "focus-ring inline-flex min-h-12 items-center justify-center gap-2 rounded-[3px] border border-primary-foreground/40 px-7 py-2.5 text-base font-semibold sm:py-4 text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover";

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
// -- covers became real links to /libra/{id} in this pass, and a linked,
// otherwise-decorative cover image needs SOME accessible name (see
// PublishedWithLibrumSection's aria-label) -- this is the same single
// query, extended by one scalar column, not a new query.
const MAX_HOMEPAGE_COVERS = 8;

// HOME-PICKS-1: one select and one mapping for the newest list and the
// staff-picked fan books, so both carry the same fields and byline.
const COVER_SELECT = "id, title, cover_path, genre, description, original_author, pen:public_pen_names(id, name)";
type CoverRow = Pick<PublicBook, "id" | "title" | "cover_path" | "genre" | "description" | "original_author"> & {
  pen: PenNameRef | null;
};

function toCover(supabase: SupabaseClient, b: CoverRow): Cover {
  return {
    id: b.id,
    title: b.title,
    author: resolveBookByline(b),
    genre: b.genre,
    description: b.description,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data.publicUrl,
  };
}

// ALL-WIRING-2: `.not("price_all", "is", null)` joins the two filters
// already here. This section links each cover to its book's detail
// page, so it is a public listing of the storefront's catalog even
// though it renders no price -- and a book with no authored ALL price
// is not part of that catalog until its author sets one. Consequence
// worth stating plainly rather than discovering later: while every
// published book is unpriced, this section renders nothing at all.
async function fetchPublishedCovers(supabase: SupabaseClient): Promise<Cover[]> {
  const { data } = await supabase
    // PEN-NAMES-2: public_books (no account columns).
    .from("public_books")
    // REDESIGN STEP 2 / PEN-NAMES-1: each book's pen name, embedded from
    // the public_pen_names view, as the bookstore does.
    // r8: genre and description too, for the three-book showcase in
    // "Published with Librum" (each book's own data, no site copy).
    .select(COVER_SELECT)
    .eq("status", "published")
    .not("price_all", "is", null)
    .not("cover_path", "is", null)
    .order("created_at", { ascending: false })
    .limit(MAX_HOMEPAGE_COVERS)
    .returns<CoverRow[]>();

  // F4 (P5): the fan and featured books show each book's byline (its
  // pen name, embedded above).
  return (data ?? []).map((b) => toCover(supabase, b));
}

// HOME-PICKS-1: the books staff put in the home slots, by id, with the
// home page's own filter (published, priced -- free = 0 counts -- and
// with a cover). A pick that no longer passes is simply missing here,
// and its slot falls back to the newest book.
async function fetchPickedCovers(supabase: SupabaseClient, ids: string[]): Promise<Map<string, Cover>> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("public_books")
    .select(COVER_SELECT)
    .in("id", ids)
    .eq("status", "published")
    .not("price_all", "is", null)
    .not("cover_path", "is", null)
    .returns<CoverRow[]>();
  if (error) {
    console.error("Home: picked books read failed:", error);
    return new Map();
  }
  return new Map((data ?? []).map((b) => [b.id, toCover(supabase, b)]));
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

  const [newestCovers, slots, userResult] = await Promise.all([
    fetchPublishedCovers(supabase),
    getPublicHomeSlots(),
    supabase.auth.getUser(),
  ]);
  const user = userResult.data.user;
  // HOME-PICKS-1 (Renato 2026-10-25): the hero fan shows the three staff
  // picks, each empty or no-longer-live slot filled by the newest book
  // not already shown. Librum's choice is no longer on the home page
  // (it stays on the Bookstore). "Published with Librum" skips the fan's
  // books while enough others exist (pickShowcaseBooks).
  const picked = await fetchPickedCovers(
    supabase,
    slots.map((slot) => slot.book_id),
  );
  const fan = resolveHomeFan(slots, picked, newestCovers);
  const showcase = pickShowcaseBooks(
    newestCovers,
    fan.map((cover) => cover.book),
  );

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
        <div className="page-container pt-10">
          <Alert variant="success">Llogaria juaj u fshi.</Alert>
        </div>
      )}

      <HeroSection cta={cta.hero} fan={fan} />
      <WhyLibrumSection />
      <PublishInFourStepsSection />
      <EarningsSection />
      {showcase.length > 0 && <PublishedWithLibrumSection books={showcase} />}
      {cta.final && <ClosingCtaBand cta={cta.final} />}
    </main>
  );
}

// ============================================================
// Section 1 — Hero: compact editorial two-column layout (author-only:
// one CTA, no reader path). Dark green band with cream text (REDESIGN
// STEP 2; it replaces the pale tint that barely showed against the page).
// HOME-PICKS-1 (Renato 2026-10-25): the right column is a fan of three
// real front covers (HomeCoverFan), staff picks with the newest books as
// fallback, replacing the spine shelf (which moved to the Bookstore).
// With fewer than three live books it falls back to the photograph
// (HeroMedia), so the live site never shows a half-empty fan or
// invented books.
// ============================================================

function HeroSection({ cta, fan }: { cta: HomepageCta | null; fan: FanCover<Cover>[] }) {
  const authorShare = computeAuthorSharePercent();
  const proofPoints = [
    `${authorShare}% për autorin`,
    "Çmimin e vendosni ju",
    "Pa tarifë fillestare",
    "Pa abonim mujor",
  ];
  const showFan = fan.length === HOME_SLOT_COUNT;

  return (
    <section className="bg-primary text-primary-foreground">
      <div
        className="page-container py-10 lg:py-14"
      >
        {/* With the cover fan the hero splits 50/50 from 1280px (xl) so
            the covers get a wider column (Renato 2026-10-25, option b).
            Narrower desktops keep 55/45: at 1024px a 50/50 split wraps
            the heading onto three lines. The photograph keeps 55/45. */}
        <div
          className={`grid gap-10 lg:grid-cols-[55fr_45fr] lg:items-center lg:gap-12 ${
            showFan ? "xl:grid-cols-[1fr_1fr]" : ""
          }`}
        >
          <div className="max-w-xl">
            <Eyebrow>Vetëbotim për autorët që shkruajnë shqip</Eyebrow>
            <h1 className="mt-5 font-serif text-4xl font-normal leading-[1.1] sm:text-5xl lg:text-[3.5rem]">
              Botoni librin tuaj.
              <br />
              <span className="italic text-accent">Siç e doni ju.</span>
            </h1>
            <p className="mt-5 max-w-md text-base leading-relaxed text-primary-foreground/85 md:text-lg">
              Platforma e vetëbotimit e ndërtuar për autorët që shkruajnë
              shqip. Botoni në mënyrë të pavarur, vendosni vetë çmimin dhe
              arrini te lexuesit përmes Librum.
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
              <Link href="/si-funksionon" className={OUTLINE_ON_DARK_CTA_CLASSES}>
                Lexoni udhëzuesin e plotë &rarr;
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

          {showFan ? (
            <HomeCoverFan covers={fan} />
          ) : (
            <HeroMedia />
          )}
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
      {/* REDESIGN STEP 2: framed like a print on the green band -- a thin
          brass rule offset behind the photograph. Decorative only. */}
      <div className="relative pr-3 pb-3">
        <div
          aria-hidden="true"
          className="absolute top-3 right-0 bottom-0 left-3 rounded-card border border-accent/70"
        />
        <div className="relative aspect-video overflow-hidden rounded-card shadow-md lg:aspect-[4/5]">
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
    heading: "Një rrugë e re drejt botimit",
    body: "Librum u jep shkrimtarëve që shkruajnë shqip një rrugë të drejtpërdrejtë për t'ua sjellë veprën lexuesve.",
  },
  {
    heading: "Kontrolli mbetet te ju",
    body: "Ju vendosni çmimin, kujdeseni për faqen e librit dhe vendosni kur botohet libri juaj.",
  },
  {
    heading: "Gjeni lexuesit tuaj",
    body: "Pasi botohet, libri juaj u del lexuesve në Librarinë e Librum.",
  },
];

function WhyLibrumSection() {
  return (
    <section className="bg-background">
      <div className={SECTION_CONTAINER}>
        <h2 className={SECTION_HEADING}>Pse Librum</h2>
        <p className="mt-3 max-w-xl text-foreground/80">
          Një rrugë e drejtpërdrejtë që shkrimtarët që shkruajnë shqip të
          botojnë në mënyrë profesionale dhe të arrijnë te lexuesit.
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
    title: "Përgatitni dorëshkrimin",
    body: "Mbajeni gati librin e përfunduar si skedar EPUB, ose si skedar DOCX që Librum e kthen në EPUB për ju, bashkë me një imazh për kopertinën.",
  },
  {
    title: "Krijoni librin",
    body: "Shtoni titullin, përshkrimin, zhanrin, kopertinën dhe të dhënat e botimit.",
  },
  {
    title: "Vendosni çmimin dhe botojeni",
    body: "Zgjidhni çmimin, kontrolloni faqen e librit dhe botojeni kur të jeni gati.",
  },
  {
    title: "Shisni dhe fitoni",
    body: "Botimi me pagesë dhe pagesat për autorët nuk kanë nisur ende. Autorët mund të vazhdojnë të botojnë libra falas ndërsa Librum përfundon sistemet e pagesave.",
  },
];

function PublishInFourStepsSection() {
  return (
    <section className="border-y border-border bg-surface">
      <div className={SECTION_CONTAINER}>
        <h2 className={SECTION_HEADING}>Botoni në katër hapa</h2>
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
            Pjesa e autorit
          </p>
        </div>
        <div className="sm:border-l sm:border-accent sm:pl-14">
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">Fitimet</p>
          <h2 className={`mt-2 ${SECTION_HEADING}`}>
            Mbani më shumë nga çdo shitje që kualifikohet.
          </h2>
          <p className="mt-3 leading-relaxed text-foreground/90">
            Librum mban një tarifë platforme prej {PLATFORM_FEE_PERCENT}%. Pa
            tarifë fillestare. Pa abonim mujor.
          </p>
          {/* r9: moved here from the deleted tools section ("Track your
              sales"), word for word. */}
          <p className="mt-2 leading-relaxed text-foreground/90">
            Ndiqni kopjet e shitura dhe të ardhurat te Paneli i autorit.
          </p>
          <Link href="/fitimet" className={`${TEXT_LINK_CLASSES} mt-4 inline-block`}>
            Shikoni si funksionojnë fitimet &rarr;
          </Link>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// Section 5 — Published with Librum: real published covers as proof.
// REDESIGN STEP 2: a white section in the mockup's frame (r8: three
// featured books, see below). Non-commerce: books link to /libra/{id} (proof that
// Librum books reach the public marketplace) but never show price/Buy/
// wishlist/rating.
// ============================================================

// REDESIGN STEP 2 r8 (Renato's card "Three featured"): a small curated
// showcase instead of a row of covers -- three books (see
// pickShowcaseBooks for which), each
// with its cover, title, author, genre and the first lines of its
// description, all the book's own data. A quiet grid, no shelf: one
// column with the cover beside the text on phones and tablets, three
// columns from lg up. Each book is one link to its page.
// HOME-PICKS-1 (Renato 2026-10-25, 3a): the three books come from
// pickShowcaseBooks -- the newest books not in the hero fan, topped up
// with fan books only when too few others exist. Never a book twice.
function PublishedWithLibrumSection({ books }: { books: Cover[] }) {
  return (
    <section className="border-y border-border bg-surface">
      <div className={SECTION_CONTAINER}>
        <h2 className={SECTION_HEADING}>Botuar me Librum</h2>
        <p className="mt-3 max-w-md text-muted">
          Libra që autorë të pavarur të Librum ua sjellin lexuesve.
        </p>

        <ul className="mt-8 grid gap-8 lg:grid-cols-3 lg:gap-10">
          {books.map((book) => (
            <li key={book.id}>
              <Link
                href={`/libra/${book.id}`}
                aria-label={`Shikoni ${book.title} në Librum`}
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
          <Link href="/librari" className={TEXT_LINK_CLASSES}>
            Shikoni librat e botuar &rarr;
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
// AUTHOR PAGES REDESIGN: the band itself is ClosingCtaBand
// (@/components/page-bands), shared with the inner author pages.
// ============================================================
