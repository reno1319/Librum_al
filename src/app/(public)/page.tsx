import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { STANDARD_ROYALTY_PERCENT } from "@/lib/royalty";
import { resolveHomepageCta, type HomepageCta } from "@/lib/homepage";
import { Alert } from "@/components/ui/alert";
import type { PublicBook } from "@/lib/types";
import { SECTION_CONTAINER } from "@/components/page-bands";
import { CREAM, Photo, PhotoShapes, Wave } from "@/components/author-page-kit";
import type { Metadata } from "next";
import { Inter, Lora } from "next/font/google";
import { isDayParam } from "@/lib/account-deletion-reasons";
import { formatDateOnly } from "@/lib/book-detail-dates";

// LIBRUM 2.0 UI-3: this page is the AUTHOR/self-publishing homepage:
// HOMEPAGE = AUTHORS, BOOKSTORE = READERS. No prices, no Buy buttons.
//
// HOMEPAGE-2 (Renato 2026-11-19): the layout follows five reference
// screenshots he chose, section by section, with his own Albanian words
// ("ju", the slogan "Ti je botuesi yt!" as he wrote it): hero, braces,
// "Ti je botuesi yt!", book types, blog, closing band. Sizes were
// measured from those screenshots and approved in pictures. The
// staff-picked cover fan and the "Botuar me Librum" row are no longer on
// the homepage; the covers beside "Ti je botuesi yt!" are the five newest
// priced books.

// LIBRUM 2.0 SEO-1: `absolute` deliberately opts this one page out of the
// root layout's "%s | Librum" title template -- the homepage's own title
// already IS the full brand title, so applying the template on top of it
// would produce "Librum — Self-Publish Your Ebook | Librum".
export const metadata: Metadata = {
  title: { absolute: "Librum — Vetëbotim për libra elektronikë" },
  description:
    "Platforma e vetëbotimit e ndërtuar për autorët që shkruajnë shqip. Botoni në mënyrë të pavarur, vendosni vetë çmimin dhe arrini te lexuesit përmes Librum.",
};

// HOMEPAGE-2 fonts (Renato 2026-11-23, "Homepage only"): Lora for
// headings and Inter for interface text, on the homepage only (its
// header and footer too). The two variables the site theme reads
// (--font-libre-caslon for font-serif, --font-libre-franklin for
// font-sans) are pointed at Lora and Inter while this page is shown;
// every other page keeps Libre Caslon and Libre Franklin. latin-ext
// covers Albanian (ë, ç).
const lora = Lora({ subsets: ["latin", "latin-ext"], weight: ["400", "700"] });
const inter = Inter({ subsets: ["latin", "latin-ext"] });
const HOME_FONTS_CSS = `html:root{--font-libre-caslon:${lora.style.fontFamily};--font-libre-franklin:${inter.style.fontFamily}}`;

type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// The five newest priced books, fanned beside "Ti je botuesi yt!".
const MAX_HOMEPAGE_COVERS = 5;

const COVER_SELECT = "id, cover_path";
type CoverRow = Pick<PublicBook, "id" | "cover_path">;

function toCover(supabase: SupabaseClient, b: CoverRow): Cover {
  return {
    id: b.id,
    url: supabase.storage.from("covers").getPublicUrl(b.cover_path!).data.publicUrl,
  };
}

// ALL-WIRING-2: only books with a price; K6 (Q2 a): no free classics
// (public-domain editions); hp2 a: no 18+ books. With fewer than three,
// the photograph shows instead of the covers.
async function fetchPublishedCovers(supabase: SupabaseClient): Promise<Cover[]> {
  const query = supabase
    // PEN-NAMES-2: public_books (no account columns).
    .from("public_books")
    .select(COVER_SELECT)
    .eq("status", "published")
    .not("price_all", "is", null)
    .not("cover_path", "is", null)
    .is("pd_work_id", null)
    // hp2 a (Renato 2026-11-19): no 18+ covers in the fan.
    .eq("is_adult", false);
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(MAX_HOMEPAGE_COVERS)
    .returns<CoverRow[]>();

  return (data ?? []).map((b) => toCover(supabase, b));
}

type Cover = { id: string; url: string };

// LIBRUM 2.0 GLOBAL VISUAL POLISH 1 / HERO-ASSET-1: resolved -- the
// approved production photograph lives at public/images/author-hero.jpg,
// served at this path. See HeroMedia's own comment for the crop
// reasoning (the image is a wide desk flat-lay, ~2560x1429/16:9-ish;
// object-position is tuned per breakpoint against its actual content).
const HERO_IMAGE_SRC = "/images/author-hero.jpg";

// HOMEPAGE-2 (Renato 2026-11-19): the homepage palette -- dark blue
// text, a yellow-orange button, teal links.
const GOLD_BUTTON =
  "focus-ring inline-flex h-10 min-w-[7.875rem] shrink-0 items-center justify-center rounded-[4px] bg-[linear-gradient(90deg,#f7cd4b,#f1a33a)] px-6 text-lg font-medium text-[#232f3e] hover:brightness-105";
const OUTLINE_BUTTON =
  "focus-ring inline-flex h-10 min-w-[7.875rem] items-center justify-center rounded-[4px] border-2 border-[#077398] bg-white px-6 text-lg font-medium text-[#077398] hover:bg-[#077398]/5";
const SECTION_HEADING = "font-serif text-3xl font-normal text-[#232f3e] lg:text-[2.125rem] leading-tight";
const TEAL_LINK = "focus-ring rounded-sm text-[#077398] hover:underline";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ account?: string; until?: string }>;
}) {
  const { account, until } = await searchParams;
  const supabase = await createClient();

  const [rowCovers, userResult] = await Promise.all([
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
    <main className="flex-1 overflow-x-hidden">
      <style>{HOME_FONTS_CSS}</style>
      <PhotoShapes />
      {/* DEL (del1 a): the account is hidden, deleted 30 days later. */}
      {account === "deletion_requested" && (
        <div className="page-container pt-10">
          <Alert variant="success">
            {isDayParam(until)
              ? `Llogaria juaj do të fshihet përgjithmonë më ${formatDateOnly(until)}. Deri atëherë mund ta riktheni duke hyrë në llogari. Ju dërguam një email me këto të dhëna.`
              : "Llogaria juaj do të fshihet përgjithmonë pas 30 ditësh. Deri atëherë mund ta riktheni duke hyrë në llogari. Ju dërguam një email me këto të dhëna."}
          </Alert>
        </div>
      )}

      <HeroSection cta={cta.hero && homepageSignupLabel(cta.hero, "Hap llogari falas")} />
      <Wave />
      <section style={{ background: CREAM }}>
        <BraceQuote />
        <PublisherRow covers={rowCovers} cta={cta.hero && homepageSignupLabel(cta.hero, "Fillo tani")} />
      </section>
      <Wave flip />
      <GenresSection />
      <LearnSection />
      {cta.final && <ClosingBand cta={homepageSignupLabel(cta.final, "Bashkohuni me LIBRUM")} />}
    </main>
  );
}

// Hero: white, a big serif heading left, closing-quote art on the
// right (filled with our hero photograph), the sentence under both, a
// gold and an outline button.
function HeroSection({ cta }: { cta: HomepageCta | null }) {
  return (
    <section className="relative overflow-hidden bg-white">
      {/* The art: a huge closing quote mark (two comma shapes) filled
          with a picture, running off the top and right edges. Ours is
          filled with the hero photograph. */}
      <svg
        aria-hidden="true"
        viewBox="0 0 640 560"
        className="pointer-events-none absolute -top-4 -right-6 hidden h-[32rem] w-auto lg:block"
      >
        <defs>
          <clipPath id="hero-quote">
            <path d="M150 0 C 262 0 318 92 298 210 C 272 360 160 478 34 550 C 20 558 6 542 16 530 C 102 446 154 352 146 276 C 64 270 0 214 0 140 C 0 60 66 0 150 0 Z" />
            <path transform="translate(330 0)" d="M150 0 C 262 0 318 92 298 210 C 272 360 160 478 34 550 C 20 558 6 542 16 530 C 102 446 154 352 146 276 C 64 270 0 214 0 140 C 0 60 66 0 150 0 Z" />
          </clipPath>
        </defs>
        <image href={HERO_IMAGE_SRC} x="-120" y="0" width="900" height="560" preserveAspectRatio="xMidYMid slice" clipPath="url(#hero-quote)" />
      </svg>
      <div className="page-container relative pt-14 pb-6 lg:pt-32 lg:pb-8">
        <h1 className="font-serif text-[2.5rem] font-bold leading-[1.2] text-[#232f3e] sm:text-5xl lg:text-[3.375rem]">
          Mirë se erdhët
          <br />
          në Librum
        </h1>
        <p className="mt-6 max-w-5xl text-xl font-medium leading-relaxed text-[#232f3e] lg:mt-14 lg:text-[1.5rem]">
          Platforma e parë e vetëbotimit shqip.
          <br />
          Shkruaj. Vetëpubliko. Fito
        </p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          {cta && (
            <Link href={cta.href} className={GOLD_BUTTON}>
              {cta.label}
            </Link>
          )}
          <Link href="/librari" className={OUTLINE_BUTTON}>
            Shfleto librarinë
          </Link>
        </div>
      </div>
    </section>
  );
}

// The list: an orange dot, a bold title, the sentence, and a teal link
// where Librum has a page for it. Titles are drafts for Renato.
type Bullet = { title: string; text: string; link?: { href: string; label: string } };
function Bullets({ items }: { items: Bullet[] }) {
  return (
    <ul className="mt-6 flex flex-col gap-5">
      {items.map((item) => (
        <li key={item.title} className="flex gap-5 text-base leading-normal text-[#0f1111]">
          <span aria-hidden="true" className="mt-[0.45em] block size-3 shrink-0 rounded-full bg-[#e2876a]" />
          <div>
            <p className="font-bold">{item.title}</p>
            <p>{item.text}</p>
            {item.link && (
              <p className="mt-2">
                <Link href={item.link.href} className={TEAL_LINK}>
                  {item.link.label}
                </Link>
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

// A line between two curly brackets: tapered brush strokes, orange on top and pink below.
function BrushBrace({ flip = false }: { flip?: boolean }) {
  const id = flip ? "brace-r" : "brace-l";
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 46 200"
      preserveAspectRatio="none"
      className={`h-24 w-[1.5rem] shrink-0 sm:h-[9.375rem] sm:w-[2.375rem] ${flip ? "-scale-x-100" : ""}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e8742a" />
          <stop offset="0.47" stopColor="#e06a22" />
          <stop offset="0.53" stopColor="#f3a2b5" />
          <stop offset="1" stopColor="#ef95ab" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M46 0 C26 4 16 18 16 42 L16 74 C16 88 10 96 0 100 C10 104 16 112 16 126 L16 158 C16 182 26 196 46 200 C36 192 32 180 32 158 L32 126 C32 110 26 102 14 100 C26 98 32 90 32 74 L32 42 C32 20 36 8 46 0 Z"
      />
    </svg>
  );
}

function BraceQuote() {
  return (
    <div className="page-container pt-8 md:pt-12">
      <div className="mx-auto flex max-w-[66rem] items-center gap-3 sm:gap-10">
        <BrushBrace />
        <p className="mx-auto max-w-[50rem] flex-1 text-center font-serif text-xl leading-[1.2] text-[#232f3e] sm:text-[2.25rem]">
          Vetëpublikoni me lehtësi dhe pa asnjë kosto fillestare. Librum ju ofron mjete falas për të botuar
          dorëshkrimin tuaj.
        </p>
        <BrushBrace flip />
      </div>
    </div>
  );
}

const ROW = "page-container mx-auto grid max-w-6xl items-center gap-10 py-12 md:grid-cols-2 md:gap-16 md:py-16";
const ROW_LEAD = "mt-4 text-xl font-medium leading-normal text-[#232f3e] md:text-[1.5rem]";

// "Ti je botuesi yt!": fanned covers left, words right.
function PublisherRow({ covers, cta }: { covers: Cover[]; cta: HomepageCta | null }) {
  const five = covers.slice(0, 5);
  const sizes = ["h-28 lg:h-36 xl:h-44", "h-32 lg:h-44 xl:h-52", "h-40 lg:h-56 xl:h-[17rem]", "h-32 lg:h-44 xl:h-52", "h-28 lg:h-36 xl:h-44"];
  return (
    <div className={ROW}>
      {five.length >= 3 ? (
        <div aria-hidden="true" className="flex items-center justify-center -space-x-4 lg:-space-x-7 xl:-space-x-9">
          {five.map((c, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={c.id}
              src={c.url}
              alt=""
              className={`${sizes[i]} aspect-[5/8] w-auto rounded-[3px] object-contain object-bottom drop-shadow-[0_6px_14px_rgba(0,0,0,0.25)] ${i === 2 ? "z-10" : ""}`}
            />
          ))}
        </div>
      ) : (
        <Photo src={HERO_IMAGE_SRC} className="aspect-[6/5]" />
      )}
      <div>
        <h2 className={SECTION_HEADING}>Ti je botuesi yt!</h2>
        <p className={ROW_LEAD}>
          Librum ju jep kontroll të plotë mbi përmbajtjen, ballinën, çmimin dhe audiencën.
        </p>
        <Bullets
          items={[
            {
              title: "Vetëpublikim pa kufij, nën kontrollin tuaj",
              text: "Në tre hapa të thjeshtë, botoni veprën tuaj në format digjital për lexuesit kudo në botë, pas miratimit nga stafi i Librum.",
            },
            {
              title: "Pronësia dhe liria janë plotësisht tuajat",
              text: "Ruani të gjitha të drejtat mbi veprën, vendosni çmimin dhe punoni me ritmin tuaj.",
            },
            {
              title: "Fitoni më shumë nga çdo shitje",
              text: `Përfitoni deri në ${STANDARD_ROYALTY_PERCENT}% të të ardhurave nga çdo shitje e librit tuaj.`,
            },
          ]}
        />
        {cta && (
          <div className="mt-8 flex flex-wrap items-center gap-x-16 gap-y-4">
            <Link href={cta.href} className={GOLD_BUTTON}>
              {cta.label}
            </Link>
            <Link href="/si-funksionon" className={`${TEAL_LINK} text-lg`}>
              Mësoni si të publikoni
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}

// Faint handwriting behind the genres: a few Albanian words in a
// pale italic serif, repeated.
const HANDWRITING_BG = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="260"><g font-family="Georgia,serif" font-style="italic" font-size="44" fill="#ecd6d0" opacity="0.4"><text x="10" y="60">shkruaj, lexo, ëndërro</text><text x="230" y="140">çdo histori ka lexuesin e vet</text><text x="40" y="225">fjalë pas fjale</text></g></svg>',
)}`;

// Book types: Renato's list (2026-11-19), 11 plus "...dhe më shumë!",
// plain words in four columns.
const BOOK_TYPES = [
  "Roman",
  "Tregim",
  "Poezi",
  "Dramaturgji",
  "Fantashkencë",
  "Pezull",
  "Romancë",
  "Biografi",
  "Kujtime",
  "Histori",
  "Zhvillim Personal",
  "...dhe më shumë!",
];

function GenresSection() {
  return (
    <section style={{ background: `#f8f1ee url("${HANDWRITING_BG}") center / 720px auto repeat` }}>
      <div className="page-container py-16 text-center md:py-24">
        <h2 className={SECTION_HEADING}>Vetëpublikoni lloje të ndryshme librash</h2>
        <ul className="mx-auto mt-12 grid max-w-5xl grid-cols-2 gap-x-8 gap-y-8 text-left sm:grid-cols-3 lg:grid-cols-4 lg:gap-y-10">
          {BOOK_TYPES.map((type) => (
            <li key={type} className="text-center text-base text-[#0f1111]">
              {type}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

// Blog: centred heading, two questions, one line, an outline button to
// the blog (not a category: staff can rename or delete categories).
// Librum has no community, so this is "Learn to self-publish".
function LearnSection() {
  return (
    <section className="bg-white">
      <div className={`${SECTION_CONTAINER} text-center`}>
        <h2 className={`${SECTION_HEADING} mx-auto max-w-4xl`}>
          Eksploro blogun e Librum
        </h2>
        <ul className="mx-auto mt-6 flex max-w-3xl flex-col gap-2 text-lg leading-relaxed text-[#0f1111]">
          <li>Keni ndonjë pyetje rreth llogarisë suaj apo se si ta promovoni librin tuaj?</li>
          <li>Dëshironi të mësoni më shumë për botën e vetëpublikimit?</li>
        </ul>
        <p className="mx-auto mt-4 max-w-3xl text-lg leading-relaxed text-[#0f1111]">
          Kërkoni ndihmë nga autorë të tjerë ose ofroni ndihmë për dikë që sapo ka filluar.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link href="/blog" className={OUTLINE_BUTTON}>
            Lexo blogun
          </Link>
        </div>
      </div>
    </section>
  );
}

// Closing band: light grey, words, button and drawing side by side.
function ClosingBand({ cta }: { cta: HomepageCta }) {
  return (
    <section className="overflow-hidden bg-[#eaeded]">
      <div className="page-container relative flex flex-col items-center justify-center gap-5 py-10 text-center md:flex-row md:gap-10 md:py-0 md:text-left xl:min-h-[10rem]">
        <div className="md:py-12">
          <h2 className="font-serif text-2xl font-normal text-[#232f3e] lg:whitespace-nowrap">
            A jeni gati për të vetëbotuar librin tuaj?
          </h2>
        </div>
        <Link href={cta.href} className={GOLD_BUTTON}>
          {cta.label}
        </Link>
        <ClosingFigure />
      </div>
    </section>
  );
}

// Our own line drawing on the band's bottom edge: a reader holding up an
// open book.
function ClosingFigure() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 200 160"
      className="absolute right-0 bottom-0 hidden h-[10rem] w-auto xl:block"
      fill="none"
      stroke="#0f1111"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="120" cy="40" r="28" />
      <circle cx="111" cy="37" r="2.5" fill="#0f1111" />
      <circle cx="129" cy="37" r="2.5" fill="#0f1111" />
      <path d="M110 50 C116 56 124 56 130 50" />
      <path d="M100 70 L94 160 M140 70 L146 160 M100 70 C112 78 128 78 140 70" />
      <path d="M100 82 L62 96 L46 84" />
      <path d="M22 62 L46 84 L70 66 M22 62 C30 58 40 60 46 66 C52 58 62 58 70 66 M46 66 L46 84" />
      <path d="M140 82 L160 110 L170 96" />
    </svg>
  );
}

// HOMEPAGE-2 (Renato 2026-11-19): the signed-out sign-up button gets the
// label he wrote for each spot; the signed-in labels (dashboard, new
// book, become an author) are left as they are.
function homepageSignupLabel(cta: HomepageCta, signedOutLabel = "Publiko librin tënd"): HomepageCta {
  return cta.href === "/signup?role=author" ? { ...cta, label: signedOutLabel } : cta;
}
