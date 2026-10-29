import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { computeAuthorSharePercent } from "@/lib/homepage";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { EarningsCalculator } from "@/components/earnings-calculator";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fitimet",
  description: "Tarifa e platformës së Librum, pjesa e autorit dhe informacioni për pagesat.",
};

const HOW_IT_WORKS = [
  "Çmimin e librit e vendosni ju: çfarëdo çmimi që doni, edhe falas.",
  `Librum merr një tarifë fikse platforme prej ${PLATFORM_FEE_PERCENT}% për çdo shitje. Kaq, Librum nuk mban asgjë tjetër.`,
  "Botimi me pagesë dhe pagesat për autorët nuk janë aktivizuar ende.",
  "Pa tarifë fillestare, pa abonim mujor, pa numër minimal shitjesh.",
  "Shitjet e rimbursuara, ose kundërshtimet e zgjidhura kundër pagesës, rregullohen në përputhje me to.",
];

const SUBHEADING = "font-serif text-2xl font-normal text-primary";

// AUTHOR PAGES REDESIGN (Renato's Q15 a): the green header band with
// today's author share, the calculator in a white two-column box, and
// the three text sections restyled. Every sentence and number is
// unchanged; royalty wording waits for the live POK build.
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
            Ju mbani {authorSharePercent}% të çdo shitjeje, Librum mban{" "}
            {PLATFORM_FEE_PERCENT}%. Pa tarifë fillestare, pa abonim mujor, pa
            minimum shitjesh. Librum fiton vetëm kur fitoni ju.
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

          {/* TRANSITIONAL-PAYMENT-COPY-2 CORRECTION: paid-book publishing and
              author payout setup have not launched yet -- see the approved
              transitional author message. Deliberately does not name POK
              here: POK is only ever named for reader checkout, never as an
              implied author-payout provider. */}
          <div>
            <h2 className={SUBHEADING}>Pagesat për autorët</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Botimi me pagesë dhe pagesat për autorët nuk janë aktivizuar ende.
              Autorët mund të vazhdojnë të publikojnë libra falas, pa konfiguruar
              pagesat, ndërsa Librum përfundon sistemet e pagesave.
            </p>
          </div>

          <div>
            <h2 className={SUBHEADING}>Çfarë mbulon tarifa</h2>
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
