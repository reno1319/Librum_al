import Link from "next/link";
import {
  REDUCED_ROYALTY_PERCENT,
  ROYALTY_PAID_PRICE_SENTENCE,
  ROYALTY_RULE_SENTENCE,
  STANDARD_ROYALTY_FROM_ALL,
  STANDARD_ROYALTY_PERCENT,
} from "@/lib/royalty";
import { groupAllDigits, MAXIMUM_CATALOG_PRICE_ALL, MINIMUM_PAID_CATALOG_PRICE_ALL } from "@/lib/catalog-price";
import { calculateAuthorEarnings, EARNINGS_BEFORE_TAX_NOTE } from "@/lib/earnings-calculator";
import { formatAllMinorUnits } from "@/lib/all-money";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { EarningsCalculator } from "@/components/earnings-calculator";
import { SECTION_HEADING } from "@/components/page-bands";
import {
  Bullets,
  CREAM,
  Dot,
  GOLD_BUTTON,
  HeroLetter,
  LightClosingBand,
  OUTLINE_BUTTON,
  Photo,
  PhotoShapes,
  Wave,
} from "@/components/author-page-kit";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fitimet",
  description: "Honorari i autorit për çdo shitje në Librum dhe informacioni për pagesat.",
};

// FITIMET (Renato 11-14, all a; then "d a": heavy "%" and the tax line
// under the table): redesigned like K5 "Si funksionon" after
// the KDP "Earn" page: a big "%" filled with a photo, an income list
// beside a brace photo, the two royalty tiers as big numbers, an example
// table (99 / 199 / 499 lekë) above the live calculator, then the
// "how it works", payouts and "what Librum's share covers" text.
//
// BD2 (Renato 11-01): Librum is the seller and pays a royalty
// ("honorar"); the tiers come from src/lib/royalty.ts. No payout date
// or method is promised before Librum publishes one, and POK is not
// named as an author-payout provider.
const PHOTO_DIR = "/images/fitimet";
const EXAMPLE_PRICES = [99, 199, 499];

const HOW_IT_WORKS = [
  `Çmimin e librit e vendosni ju: falas, ose nga ${MINIMUM_PAID_CATALOG_PRICE_ALL} deri në ${groupAllDigits(MAXIMUM_CATALOG_PRICE_ALL)} lekë.`,
  ROYALTY_RULE_SENTENCE,
  ROYALTY_PAID_PRICE_SENTENCE,
  `Librum mban pjesën tjetër (${100 - STANDARD_ROYALTY_PERCENT}%, ose ${100 - REDUCED_ROYALTY_PERCENT}% nën ${STANDARD_ROYALTY_FROM_ALL} lekë) dhe nuk ju zbret asgjë tjetër.`,
  "Pa tarifë fillestare, pa abonim mujor, pa numër minimal shitjesh.",
  "Shitjet e rimbursuara, ose kundërshtimet e zgjidhura kundër pagesës, rregullohen në përputhje me to.",
];

const BIG_NUMBER = "font-serif text-7xl leading-none text-[#b4572a] sm:text-8xl";
const TH = "border border-[#e4dccb] px-4 py-3 text-left font-semibold text-primary";
const TD = "border border-[#e4dccb] px-4 py-3";

export default async function PricingPage() {
  const cta = await getAuthorPageCta();
  const signedOut = !cta || cta.href.startsWith("/signup");
  const examples = EXAMPLE_PRICES.map((price) => ({ price, ...calculateAuthorEarnings(price, 1) }));

  return (
    <main className="flex-1 overflow-x-hidden">
      <PhotoShapes />

      {/* Hero: text left, a big "%" filled with a photo right. */}
      <section className="overflow-hidden bg-white">
        <div className="page-container grid items-end gap-6 md:grid-cols-[1.05fr_0.95fr]">
          <div className="max-w-xl self-center pt-12 md:py-20">
            <h1 className="font-serif text-[2.75rem] font-normal leading-[1.05] text-primary sm:text-6xl lg:text-[4rem]">
              Fitoni nga çdo libër që shitet
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-foreground/85 md:text-xl">
              Për çdo shitje merrni {STANDARD_ROYALTY_PERCENT}% të çmimit si honorar, për libra nga{" "}
              {STANDARD_ROYALTY_FROM_ALL} lekë, dhe {REDUCED_ROYALTY_PERCENT}% nën {STANDARD_ROYALTY_FROM_ALL} lekë. Pa
              tarifë fillestare, pa abonim mujor, pa minimum shitjesh. Librum fiton vetëm kur fitoni ju.
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
            <HeroLetter char="%" src={`${PHOTO_DIR}/hero.jpg`} heavy />
          </div>
        </div>
      </section>

      {/* Income list beside a brace photo, on cream. */}
      <Wave />
      <section style={{ background: CREAM }}>
        <div className="page-container mx-auto grid max-w-5xl items-center gap-10 py-10 md:grid-cols-2 md:gap-14 md:py-14">
          <Photo src={`${PHOTO_DIR}/income.jpg`} className="aspect-[6/5]" />
          <div>
            <h2 className={SECTION_HEADING}>Më shumë mënyra për të fituar</h2>
            <Bullets
              items={[
                <>
                  Merrni <strong>{STANDARD_ROYALTY_PERCENT}% honorar</strong> për çdo libër nga {STANDARD_ROYALTY_FROM_ALL}{" "}
                  lekë e lart, dhe {REDUCED_ROYALTY_PERCENT}% për librat më të lirë.
                </>,
                <>
                  Shisni librat tuaj edhe në <strong>paketa</strong>: honorari llogaritet nga çmimi i paketës.
                </>,
                <>
                  Me <strong>parapublikimin</strong>, libri juaj shfaqet në Librari deri në 6 muaj para daljes, dhe
                  lexuesit që shtypin «Më njofto» marrin një email ditën që libri publikohet.
                </>,
              ]}
            />
          </div>
        </div>
      </section>
      <Wave flip />

      {/* The two royalty tiers as big numbers. */}
      <section className="bg-white">
        <div className="page-container py-12 text-center md:py-16">
          <h2 className={SECTION_HEADING}>Honorari për librat elektronikë</h2>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-foreground/85">Honorari varet nga çmimi që vendosni ju.</p>
          <div className="mx-auto mt-10 grid max-w-4xl gap-12 md:grid-cols-2">
            <div>
              <p className={BIG_NUMBER}>{STANDARD_ROYALTY_PERCENT}%</p>
              <p className="mt-4 font-serif text-xl text-primary">Pjesa e autorit</p>
              <p className="mx-auto mt-3 max-w-sm leading-relaxed text-foreground/85">
                Për libra me çmim nga {STANDARD_ROYALTY_FROM_ALL} lekë e lart: {STANDARD_ROYALTY_PERCENT}% e çmimit që
                paguan lexuesi.
              </p>
            </div>
            <div>
              <p className={BIG_NUMBER}>{REDUCED_ROYALTY_PERCENT}%</p>
              <p className="mt-4 font-serif text-xl text-primary">Pjesa e autorit</p>
              <p className="mx-auto mt-3 max-w-sm leading-relaxed text-foreground/85">
                Për libra me çmim nga {MINIMUM_PAID_CATALOG_PRICE_ALL} deri në {STANDARD_ROYALTY_FROM_ALL - 1} lekë:{" "}
                {REDUCED_ROYALTY_PERCENT}% e çmimit që paguan lexuesi.
              </p>
            </div>
          </div>
          <hr className="mx-auto mt-14 max-w-5xl border-border" />

          {/* Example table, then the live calculator. */}
          <h2 className={`${SECTION_HEADING} mt-14`}>Shihni sa fitoni</h2>
          <p className="mt-3 text-[0.9375rem] italic text-foreground/75">Shembuj për një shitje</p>
          <div className="mx-auto mt-8 max-w-4xl overflow-x-auto text-left">
            <table className="w-full min-w-[34rem] border-collapse bg-white text-[0.9375rem]">
              <thead>
                <tr>
                  <th className={TH} scope="col">
                    <span className="sr-only">Rreshti</span>
                  </th>
                  {examples.map((e) => (
                    <th key={e.price} className={`${TH} font-serif text-lg font-normal`} scope="col">
                      Libër {e.price} lekë
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th className={TH} scope="row">
                    Çmimi që paguan lexuesi
                  </th>
                  {examples.map((e) => (
                    <td key={e.price} className={TD}>
                      {formatAllMinorUnits(e.grossMinor)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <th className={TH} scope="row">
                    Honorari
                  </th>
                  {examples.map((e) => (
                    <td key={e.price} className={TD}>
                      {e.royaltyPercent}%
                    </td>
                  ))}
                </tr>
                <tr>
                  <th className={TH} scope="row">
                    Tarifë dërgimi ose tjetër
                  </th>
                  {examples.map((e) => (
                    <td key={e.price} className={TD}>
                      0 lekë
                    </td>
                  ))}
                </tr>
                <tr className="bg-[#f3e7c4]">
                  <th className={TH} scope="row">
                    Fitimi juaj
                  </th>
                  {examples.map((e) => (
                    <td key={e.price} className={`${TD} text-base`}>
                      <strong>{formatAllMinorUnits(e.authorEarningsMinor)}</strong> për shitje
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
            <p className="mt-3 px-1 text-sm text-foreground/75">{ROYALTY_PAID_PRICE_SENTENCE}</p>
            <p className="mt-1 px-1 text-sm text-foreground/75">{EARNINGS_BEFORE_TAX_NOTE}</p>
          </div>
          <div className="mx-auto mt-12 max-w-4xl text-left">
            <EarningsCalculator />
          </div>
        </div>
      </section>

      {/* How it works, payouts and what Librum's share covers, on cream. */}
      <Wave />
      <section style={{ background: CREAM }}>
        <div className="page-container grid gap-10 py-10 md:py-14 lg:grid-cols-3">
          <div>
            <h2 className="font-serif text-2xl font-normal text-primary">Si funksionon</h2>
            <ul className="mt-4 flex flex-col gap-3 leading-relaxed text-foreground/90">
              {HOW_IT_WORKS.map((line) => (
                <li key={line} className="flex gap-3">
                  <Dot />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* No payout date or method promised before Librum publishes
              one; POK is not named as an author-payout provider. */}
          <div>
            <h2 className="font-serif text-2xl font-normal text-primary">Pagesat për autorët</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Honorari juaj shfaqet te Paneli i autorit, te Shitjet dhe te Bilanci. Librum do ta publikojë këtu mënyrën
              dhe kohën e pagesave për autorët para pagesës së parë.
            </p>
          </div>

          <div>
            <h2 className="font-serif text-2xl font-normal text-primary">Çfarë mbulon pjesa e Librum</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Ruajtjen e skedarëve, pagesën e sigurt, dërgimin e librit elektronik dhe shenjën e ujit në skedar, si dhe
              çdo mjet në Panelin e autorit: statistikat e shitjeve, kodet e zbritjes, seritë dhe emrat e
              bashkëpunëtorëve. Të gjitha të përfshira, pa pagesë shtesë.
            </p>
          </div>
        </div>
      </section>
      <Wave flip />

      {cta && <LightClosingBand cta={cta} />}
    </main>
  );
}
