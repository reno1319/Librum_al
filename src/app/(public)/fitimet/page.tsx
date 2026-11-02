import {
  REDUCED_ROYALTY_PERCENT,
  ROYALTY_HEADLINE_CAPTION,
  ROYALTY_PAID_PRICE_SENTENCE,
  ROYALTY_RULE_SENTENCE,
  STANDARD_ROYALTY_FROM_ALL,
  STANDARD_ROYALTY_PERCENT,
} from "@/lib/royalty";
import { computeAuthorSharePercent } from "@/lib/homepage";
import { groupAllDigits, MAXIMUM_CATALOG_PRICE_ALL, MINIMUM_PAID_CATALOG_PRICE_ALL } from "@/lib/catalog-price";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { EarningsCalculator } from "@/components/earnings-calculator";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fitimet",
  description: "Honorari i autorit për çdo shitje në Librum dhe informacioni për pagesat.",
};

const HOW_IT_WORKS = [
  `Çmimin e librit e vendosni ju: falas, ose nga ${MINIMUM_PAID_CATALOG_PRICE_ALL} deri në ${groupAllDigits(MAXIMUM_CATALOG_PRICE_ALL)} lekë.`,
  ROYALTY_RULE_SENTENCE,
  ROYALTY_PAID_PRICE_SENTENCE,
  `Librum mban pjesën tjetër (${100 - STANDARD_ROYALTY_PERCENT}%, ose ${100 - REDUCED_ROYALTY_PERCENT}% nën ${STANDARD_ROYALTY_FROM_ALL} lekë) dhe nuk ju zbret asgjë tjetër.`,
  "Pa tarifë fillestare, pa abonim mujor, pa numër minimal shitjesh.",
  "Shitjet e rimbursuara, ose kundërshtimet e zgjidhura kundër pagesës, rregullohen në përputhje me to.",
];

const SUBHEADING = "font-serif text-2xl font-normal text-primary";

// AUTHOR PAGES REDESIGN (Renato's Q15 a): the green header band with
// today's author share, the calculator in a white two-column box, and
// the three text sections restyled. Every sentence and number is
// unchanged; royalty wording waits for the live POK build.
//
// BD2 (Renato 11-01: 2a, 4a, 7b): Librum is the seller and pays a
// royalty ("honorar"); the tiers come from src/lib/royalty.ts. The "fixed
// fee, nothing else" line and the "not activated yet" lines are gone.
export default async function PricingPage() {
  const authorSharePercent = computeAuthorSharePercent();
  const cta = await getAuthorPageCta();

  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Fitimet"
        title="Fitimet"
        lead={
          <>
            Për çdo shitje merrni {authorSharePercent}% të çmimit si honorar,
            për libra nga {STANDARD_ROYALTY_FROM_ALL} lekë, dhe{" "}
            {REDUCED_ROYALTY_PERCENT}% nën {STANDARD_ROYALTY_FROM_ALL} lekë. Pa
            tarifë fillestare, pa abonim mujor, pa minimum shitjesh. Librum
            fiton vetëm kur fitoni ju.
          </>
        }
        aside={
          <div className="border-t border-accent pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-10">
            <span className="block font-serif text-6xl leading-none font-normal sm:text-7xl lg:text-8xl">
              {authorSharePercent}%
            </span>
            <p className="mt-2 text-sm font-medium tracking-wide text-primary-foreground/85 uppercase">
              Pjesa e autorit
            </p>
            <p className="mt-1 text-sm text-primary-foreground/85">{ROYALTY_HEADLINE_CAPTION}</p>
          </div>
        }
      />

      <section className="bg-background">
        <div className={SECTION_CONTAINER}>
          <EarningsCalculator />
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className={`${SECTION_CONTAINER} grid gap-10 lg:grid-cols-3`}>
          <div>
            <h2 className={SUBHEADING}>Si funksionon</h2>
            <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 leading-relaxed text-foreground/90 marker:text-[#8a6d12]">
              {HOW_IT_WORKS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          {/* TRANSITIONAL-PAYMENT-COPY-2 CORRECTION, BD2 (7b): no "not
              launched yet" sentence any more, and still no payout date or
              method promised before Librum publishes one. Deliberately does not name POK
              here: POK is only ever named for reader checkout, never as an
              implied author-payout provider. */}
          <div>
            <h2 className={SUBHEADING}>Pagesat për autorët</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Honorari juaj shfaqet te Paneli i autorit, te Shitjet dhe te
              Bilanci. Librum do ta publikojë këtu mënyrën dhe kohën e pagesave për
              autorët para pagesës së parë.
            </p>
          </div>

          <div>
            <h2 className={SUBHEADING}>Çfarë mbulon pjesa e Librum</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Ruajtjen e skedarëve, pagesën e sigurt, dërgimin e librit elektronik
              dhe shenjën e ujit në skedar, si dhe çdo mjet në Panelin e autorit:
              statistikat e shitjeve, kodet e zbritjes, seritë dhe emrat e
              bashkëpunëtorëve. Të gjitha të përfshira, pa pagesë shtesë.
            </p>
          </div>
        </div>
      </section>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
