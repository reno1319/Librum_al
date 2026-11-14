import Link from "next/link";
import { ROYALTY_RULE_SENTENCE, STANDARD_ROYALTY_FROM_ALL, STANDARD_ROYALTY_PERCENT } from "@/lib/royalty";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { SECTION_HEADING, TEXT_LINK_CLASSES } from "@/components/page-bands";
import type { Metadata } from "next";
import { Playfair_Display } from "next/font/google";

export const metadata: Metadata = {
  title: "Si funksionon",
  description: "Si ta përgatitni, ta publikoni, t'i vini çmimin dhe ta shisni librin tuaj elektronik me Librum.",
};

// K5 (Kolibër list, Renato 11-14): the page is redesigned after the KDP
// "Publish" page he sent: a big flourished "L" filled with a bookshelf
// photo, wavy cream sections, three steps with brace-shaped photos, the
// Word block with a picture of our own reader, the free tools and a light
// closing band. The words are his, from the wording doc.
const REDUCED_PERCENT = 50;
const EXAMPLE_PRICE = 499;
const EXAMPLE_SHARE = Math.floor((EXAMPLE_PRICE * STANDARD_ROYALTY_PERCENT) / 100);

const PHOTO_DIR = "/images/si-funksionon";
const CREAM = "#fbf8f1";

// The brace shape of the photos: rounded corners and a small point in the
// middle of each side, like a curly bracket. Drawn once, used by every Photo.
function PhotoShapes() {
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

function Photo({ name, className = "" }: { name: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`${PHOTO_DIR}/${name}.jpg`}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={`w-full object-cover [clip-path:url(#lb-brace)] ${className}`}
    />
  );
}

// The hero letter: one big "L" from a real typeface, filled with the
// bookshelf photo, running off the right edge like the KDP "A".
const letterFont = Playfair_Display({ weight: "900", style: "italic", subsets: ["latin"], display: "swap" });

function HeroLetter() {
  return (
    <span
      aria-hidden="true"
      className={`${letterFont.className} block select-none whitespace-nowrap text-right leading-[1.02] text-transparent [-webkit-background-clip:text] [background-clip:text] [font-size:clamp(15rem,40vw,36rem)]`}
      style={{
        backgroundImage: `url(${PHOTO_DIR}/hero.jpg)`,
        backgroundSize: "cover",
        backgroundPosition: "center 30%",
      }}
    >
      L
    </span>
  );
}

// A soft wave where a white section meets a cream one.
function Wave({ flip = false }: { flip?: boolean }) {
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

function Dot() {
  return <span aria-hidden="true" className="mt-[0.55em] block size-2.5 shrink-0 rounded-full bg-[#d98e5f]" />;
}

function Bullets({ items }: { items: React.ReactNode[] }) {
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

const STEP_TITLE = "font-serif text-[1.5rem] font-normal leading-tight text-primary sm:text-[1.75rem]";
const GOLD_BUTTON =
  "focus-ring inline-flex min-h-12 shrink-0 items-center rounded-md bg-accent px-7 font-semibold text-accent-foreground hover:brightness-105";
const OUTLINE_BUTTON =
  "focus-ring inline-flex min-h-12 items-center rounded-md border-2 border-primary px-7 font-semibold text-primary hover:bg-primary/5";

const TOOLS = [
  { heading: "Seritë", body: "Gruponi librat tuaj, sipas radhës së leximit, në një seri." },
  {
    heading: "Parapublikimi",
    body: "Vendoseni librin në Librari deri në 6 muaj para datës së publikimit. Lexuesit që shtypin «Më njofto» marrin një email ditën që libri juaj publikohet.",
  },
  { heading: "Kodet e zbritjes", body: "Krijoni kode zbritjeje për lexuesit tuaj." },
  { heading: "Ndjekësit", body: "Lexuesit që ju ndjekin marrin një email kur publikoni një libër të ri." },
  { heading: "Pjesë falas", body: "Lexuesit mund të lexojnë falas fillimin e librit tuaj." },
];

// A still picture of the Librum reader on an ebook reader (portrait, one
// page), drawn with the reader's own colours, bars and controls. The page
// text is placeholder Latin, as on KDP. Not interactive.
const LOREM = [
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed id nulla sit amet sapien ultrices aliquam at quis urna. Fusce sit amet magna ligula. Mauris sed egestas arcu. Donec massa orci, porttitor vitae tristique et, mollis vitae mauris.",
  "In bibendum, sapien vitae iaculis efficitur, risus nisi fermentum ipsum, non faucibus sapien neque vel leo. Nulla nec facilisis mauris, ac congue diam. Sed aliquet elementum scelerisque.",
  "Aenean vitae urna vel nunc sollicitudin lacinia. Vestibulum varius enim id semper maximus. Curabitur interdum quam ut fringilla blandit. Quisque sodales odio eu nulla aliquam fermentum.",
  "Morbi scelerisque neque vitae condimentum facilisis. Nam sit amet ullamcorper elit. Aliquam dictum diam a vehicula ultricies. Etiam ornare leo felis, ut fermentum sem dapibus et. Fusce sed sem quam.",
  "Nullam imperdiet vestibulum pretium. Mauris ut gravida arcu. Ut mattis tellus ut laoreet laoreet. Quisque hendrerit facilisis pharetra. Donec volutpat sodales tortor, id suscipit sapien.",
  "Sed hendrerit ullamcorper ex quis porttitor. Suspendisse consequat eros nec velit malesuada hendrerit. Maecenas pellentesque, lacus eu hendrerit condimentum, lectus nulla lacinia est.",
];

function ReaderPicture() {
  const bar = "#faf8f3";
  const border = "#ddd6c8";
  const muted = "#6f6a62";
  return (
    <div
      aria-hidden="true"
      className="mx-auto mt-10 w-[17.5rem] rounded-[2rem] bg-[#1d1d1f] p-3 text-left shadow-[0_24px_60px_rgba(0,0,0,0.28)] sm:w-[20rem]"
    >
      <div className="overflow-hidden rounded-[1.4rem]" style={{ background: "#fff" }}>
        <div className="flex items-center gap-1 border-b px-2 py-1.5" style={{ background: bar, borderColor: border }}>
          <span className="flex size-7 items-center justify-center text-[#1f1d1a]">
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </span>
          <div className="min-w-0 flex-1 text-center">
            <p className="truncate font-serif text-[11px] font-semibold leading-tight text-[#1f1d1a]">Titulli i librit</p>
            <p className="truncate text-[9px] leading-tight" style={{ color: muted }}>
              nga Emri i autorit
            </p>
          </div>
          <span className="flex size-7 items-center justify-center text-[#1f1d1a]">
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />
            </svg>
          </span>
          <span className="flex size-7 items-center justify-center font-serif text-[12px] leading-none text-[#1f1d1a]">
            A<span className="text-[9px]">a</span>
          </span>
        </div>
        <div className="h-[24rem] overflow-hidden px-5 pt-7 sm:h-[27rem] sm:px-6">
          <p className="text-center font-serif text-xl text-[#1f1d1a]">XI</p>
          {LOREM.map((para, i) => (
            <p
              key={i}
              className={`font-serif text-[9.5px] leading-[1.55] text-[#1f1d1a] [hyphens:auto] [text-align:justify] sm:text-[10.5px] ${i === 0 ? "mt-6" : "mt-1.5 indent-3"}`}
              lang="la"
            >
              {para}
            </p>
          ))}
        </div>
        <div className="border-t px-4 pb-2 pt-1.5" style={{ background: bar, borderColor: border }}>
          <div className="relative h-3">
            <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-[#ddd6c8]" />
            <div className="absolute left-0 top-1/2 h-[3px] w-[38%] -translate-y-1/2 rounded-full bg-[#c0841a]" />
            <div className="absolute left-[38%] top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#c0841a] shadow" />
          </div>
          <p className="text-center text-[9px] tabular-nums" style={{ color: muted }}>
            Faqe 92 nga 240 · 38%
          </p>
        </div>
      </div>
    </div>
  );
}

export default async function HowItWorksPage() {
  const cta = await getAuthorPageCta();
  const signedOut = !cta || cta.href.startsWith("/signup");

  return (
    <main className="flex-1 overflow-x-hidden">
      <PhotoShapes />

      {/* Hero: text left, the big L right, running off the edge. */}
      <section className="overflow-hidden bg-white">
        <div className="page-container grid items-end gap-6 md:grid-cols-[1.05fr_0.95fr]">
          <div className="max-w-xl self-center pt-12 md:py-20">
            <h1 className="font-serif text-[2.75rem] font-normal leading-[1.05] text-primary sm:text-6xl lg:text-[4rem]">
              Botoni librin tuaj në shqip
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-foreground/85 md:text-xl">
              Ngarkoni dorëshkrimin, vendosni çmimin dhe merrni {STANDARD_ROYALTY_PERCENT}% nga çdo shitje nga{" "}
              {STANDARD_ROYALTY_FROM_ALL} lekë e lart. Pa tarifë fillestare, pa abonim mujor.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              {signedOut ? (
                <>
                  <Link href="/signup?role=author" className={GOLD_BUTTON}>
                    Regjistrohu
                  </Link>
                  <Link href="/login" className={OUTLINE_BUTTON}>
                    Hyr
                  </Link>
                </>
              ) : (
                <Link href={cta.href} className={GOLD_BUTTON}>
                  {cta.label}
                </Link>
              )}
            </div>
          </div>
          <div className="-mr-4 pt-4 sm:-mr-6 md:pt-8">
            <HeroLetter />
          </div>
        </div>
      </section>

      {/* Three steps on cream, between two waves. */}
      <Wave />
      <section style={{ background: CREAM }}>
        <div className="page-container py-10 md:py-14">
          <h2 className={`${SECTION_HEADING} text-center`}>Botoni në tre hapa</h2>

          <div className="mx-auto mt-12 flex max-w-5xl flex-col gap-16 md:mt-16 md:gap-24">
            <article className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
              <div className="md:order-1">
                <h3 className={STEP_TITLE}>
                  <span className="font-bold">Hapi 1:</span> Përgatitni librin
                </h3>
                <Bullets
                  items={[
                    "Dorëshkrimi duhet të jetë në formatin Word (DOCX) dhe Librum e kthen dokumentin në EPUB për ju. Mund të ngarkoni edhe dokument EPUB të gatshëm.",
                    "Përgatitni një ballinë në formatin JPG/PNG, mundësisht 1600 × 2560 px dhe të paktën 1000 px e lartë, deri në 5 MB.",
                    "Dorëshkrimi mund të jetë deri në 50 MB.",
                  ]}
                />
                <p className="mt-5 pl-[1.625rem]">
                  <Link href="/ndihme/word" className={TEXT_LINK_CLASSES}>
                    Si ta përgatitni dorëshkrimin në Word
                  </Link>
                </p>
              </div>
              <Photo name="prepare" className="aspect-[6/5] md:order-2" />
            </article>

            <article className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
              <Photo name="publish" className="aspect-[6/5] md:order-1" />
              <div className="md:order-2">
                <h3 className={STEP_TITLE}>
                  <span className="font-bold">Hapi 2:</span> Publikoni
                </h3>
                <Bullets
                  items={[
                    "Krijoni një llogari si autor dhe hyni në Panelin e autorit.",
                    "Shtoni titullin, bëni një përshkrim të librit tuaj, zgjidhni deri në 3 zhanre, fjalët kyçe dhe vendosni çmimin: nga 99 lekë, ose falas për veprat që janë në domenin publik.",
                    "Zgjidhni deklaratën e të drejtave që i korrespondon librit tuaj.",
                    "Dërgojeni librin për shqyrtim. Pasi Librum ta miratojë, libri shfaqet në Librari për t'u shitur.",
                  ]}
                />
              </div>
            </article>

            <article className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
              <div className="md:order-1">
                <h3 className={STEP_TITLE}>
                  <span className="font-bold">Hapi 3:</span> Fitoni
                </h3>
                <div className="mt-6 flex flex-wrap items-end gap-x-6 gap-y-2">
                  <p className="font-serif text-7xl leading-none text-primary sm:text-8xl">{STANDARD_ROYALTY_PERCENT}%</p>
                  <div className="pb-1.5">
                    <p className="text-lg font-semibold text-primary">nga {STANDARD_ROYALTY_FROM_ALL} lekë</p>
                    <p className="text-[0.9375rem] text-muted">
                      {REDUCED_PERCENT}% kur çmimi është nën {STANDARD_ROYALTY_FROM_ALL} lekë
                    </p>
                  </div>
                </div>
                <p className="mt-5 rounded-md border border-[#e7dfc9] bg-white px-4 py-3 text-[0.9375rem]">
                  Për një libër që kushton {EXAMPLE_PRICE} lekë →{" "}
                  <strong className="text-primary">ju fitoni {EXAMPLE_SHARE} lekë</strong>
                </p>
                <Bullets
                  items={[
                    // BD2 (Renato 11-01): every money page says Librum sells
                    // the book and pays the author a royalty.
                    ROYALTY_RULE_SENTENCE,
                    "Fitimi juaj llogaritet pas kodit të zbritjes, nëse ka, ose nga çmimi i paketës, nëse libri shitet në paketë.",
                    "Çdo kopje libri që shkarkohet mban emailin e blerësit, çka lejon gjurmimin e kopjes së shpërndarë.",
                    "Mënyrën dhe kohën e pagesave për autorët Librum do t'i publikojë para pagesës së parë.",
                  ]}
                />
              </div>
              <Photo name="earn" className="aspect-[6/5] md:order-2" />
            </article>
          </div>
        </div>
      </section>
      <Wave flip />

      {/* Word block: our own reader, as KDP shows its book. */}
      <section className="bg-white">
        <div className="page-container py-12 text-center md:py-16">
          <h2 className={SECTION_HEADING}>E keni dorëshkrimin në Word?</h2>
          <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-foreground/85">
            Ngarkoni dokumentin DOCX dhe Librum e kthen në EPUB. Faqja e përmbajtjes dhe faqja e të drejtave të autorit
            krijohen vetë. Kontrollojeni mirë para se ta dërgoni librin për shqyrtim.
          </p>
          <ReaderPicture />
          <Link href="/ndihme/word" className={`${OUTLINE_BUTTON} mt-10`}>
            Lexo udhëzuesin për Word
          </Link>
        </div>
      </section>

      {/* Free tools beside one photo, on cream. */}
      <Wave />
      <section style={{ background: CREAM }}>
        <div className="page-container mx-auto grid max-w-5xl items-center gap-10 py-10 md:grid-cols-[1.1fr_0.9fr] md:gap-14 md:py-14">
          <div>
            <h2 className={SECTION_HEADING}>Mjete falas për librin tuaj</h2>
            <ul className="mt-8 flex flex-col gap-6">
              {TOOLS.map((tool) => (
                <li key={tool.heading} className="flex gap-4">
                  <Dot />
                  <div>
                    <h3 className="text-lg font-bold text-primary">{tool.heading}</h3>
                    <p className="mt-1 leading-relaxed text-foreground/85">{tool.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <Photo name="tools" className="aspect-[5/6]" />
        </div>
        <div className="page-container pb-10">
          <p className="text-center text-sm text-foreground/90">
            Keni pyetje? Shihni{" "}
            <Link href="/ndihme" className={TEXT_LINK_CLASSES}>
              faqen e ndihmës
            </Link>
            .
          </p>
        </div>
      </section>

      {/* Closing band, light, heading and button side by side. */}
      {cta && (
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
      )}
    </main>
  );
}
