import Link from "next/link";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { REPLY_PROMISE, SUPPORT_EMAIL } from "@/lib/contact";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Si ta lexoni librin tuaj",
  description: "Ku janë librat që shkarkoni nga Librum dhe si të hapni një EPUB në iPhone, Android, kompjuter ose Kindle.",
};

// TRUST PACK (pipeline item 5, Renato 10-24): the reader help page
// (1. a: its own page, linked from Help, the Library and the line next
// to Download). 2. a: it names Apple Books, Google Play Books, Thorium
// Reader and Amazon's Send to Kindle, with a link to Amazon's page.
// The cancel paragraph repeats the Refund Policy's 14-day rule and the
// warning DOWNLOADS-1 shows next to Download; it adds no rule of its own.
export const SEND_TO_KINDLE_HREF = "https://www.amazon.com/sendtokindle";
export const THORIUM_HREF = "https://thorium.edrlab.org/";

const DEVICES: { id: string; heading: string; steps: string[] }[] = [
  {
    id: "iphone",
    heading: "iPhone ose iPad",
    steps: [
      "Prekni \"Shkarkoni EPUB\". Safari e ruan librin te aplikacioni Files (Skedarët).",
      "Hapni aplikacionin Files dhe shkoni te Downloads (Shkarkimet).",
      "Prekni librin, prekni butonin e ndarjes (Share), pastaj zgjidhni Books.",
      "Libri hapet në Apple Books dhe mbetet në bibliotekën e tij.",
    ],
  },
  {
    id: "android",
    heading: "Telefon ose tablet Android",
    steps: [
      "Prekni \"Shkarkoni EPUB\". Libri ruhet në dosjen Downloads (Shkarkimet).",
      "Hapni aplikacionin Files (në disa telefona quhet My Files) dhe shkoni te Downloads.",
      "Prekni librin dhe zgjidhni Google Play Books ose një aplikacion tjetër leximi për EPUB.",
      "Nëse asnjë aplikacion nuk ofrohet ta hapë, instaloni Google Play Books nga Play Store dhe provoni përsëri.",
    ],
  },
  {
    id: "computer",
    heading: "Kompjuter",
    steps: [
      "Klikoni \"Shkarkoni EPUB\". Libri ruhet në dosjen Downloads (Shkarkimet).",
      "Në Mac, klikoni dy herë mbi librin dhe ai hapet në Apple Books.",
      "Në Windows, instaloni Thorium Reader (falas), pastaj hapeni librin me të.",
    ],
  },
];

const LINK_CLASSES = "text-primary underline";

export default function ReadingHelpPage() {
  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Ndihmë"
        title="Si ta lexoni librin tuaj"
        lead="Çdo libër i Librum është një skedar EPUB pa DRM, prandaj hapet në aplikacionin e leximit që përdorni tashmë."
      >
        <nav aria-label="Pajisjet" className="mt-6">
          <ul className="flex flex-wrap gap-2.5">
            {[...DEVICES, { id: "kindle", heading: "Kindle" }].map((device) => (
              <li key={device.id}>
                <a
                  href={`#${device.id}`}
                  className="focus-ring inline-flex min-h-11 items-center rounded-[3px] border border-primary-foreground/40 px-4 text-sm font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover"
                >
                  {device.heading}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageBand>

      <div className={SECTION_CONTAINER}>
        <div className="flex max-w-2xl flex-col gap-10 leading-relaxed text-foreground/90">
          <section aria-labelledby="where-heading">
            <h2 id="where-heading" className="font-serif text-2xl font-normal text-primary">
              Ku janë librat tuaj
            </h2>
            <p className="mt-3">
              Çdo libër që merrni në Librum, falas ose me pagesë, është te{" "}
              <Link href="/library" className={LINK_CLASSES}>
                Biblioteka ime
              </Link>
              . Prekni &quot;Shkarkoni EPUB&quot; poshtë librit për ta ruajtur në telefon ose
              kompjuter. Mund ta shkarkoni përsëri sa herë të keni nevojë, për
              shembull në një telefon të ri.
            </p>
          </section>

          <section aria-labelledby="cancel-heading">
            <h2 id="cancel-heading" className="font-serif text-2xl font-normal text-primary">
              Para shkarkimit të parë
            </h2>
            <p className="mt-3">
              Mund ta anuloni një blerje me pagesë brenda 14 ditëve, për sa kohë
              nuk e keni shkarkuar ende librin. Shkarkimi i parë e mbyll këtë
              të drejtë. Sa kohë që mund ta anuloni ende, do të shihni një
              kujtesë pranë butonit të shkarkimit. Librat falas nuk kanë asgjë
              për të anuluar. Hollësitë janë te faqja{" "}
              <Link href="/refunds" className={LINK_CLASSES}>
                Rimbursimet
              </Link>
              .
            </p>
          </section>

          {DEVICES.map((device) => (
            <section key={device.id} id={device.id} aria-labelledby={`${device.id}-heading`} className="scroll-mt-6">
              <h2 id={`${device.id}-heading`} className="font-serif text-2xl font-normal text-primary">
                {device.heading}
              </h2>
              <ol className="mt-3 list-decimal pl-5">
                {device.steps.map((step) => (
                  <li key={step} className="mt-1.5">
                    {step}
                  </li>
                ))}
              </ol>
              {device.id === "computer" && (
                <p className="mt-3 text-sm text-muted">
                  Thorium Reader:{" "}
                  <a href={THORIUM_HREF} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
                    thorium.edrlab.org
                    <span className="sr-only"> (hapet në një skedë të re)</span>
                  </a>
                </p>
              )}
            </section>
          ))}

          <section id="kindle" aria-labelledby="kindle-heading" className="scroll-mt-6">
            <h2 id="kindle-heading" className="font-serif text-2xl font-normal text-primary">
              Kindle
            </h2>
            <p className="mt-3">
              Kindle nuk i hap skedarët EPUB drejtpërdrejt nga shkarkimet, por
              shërbimi falas Send to Kindle i Amazon i pranon. Fillimisht
              shkarkoni librin, pastaj dërgojeni nga{" "}
              <a href={SEND_TO_KINDLE_HREF} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
                faqja Send to Kindle e Amazon
                <span className="sr-only"> (hapet në një skedë të re)</span>
              </a>
              . Pastaj libri shfaqet në Kindle dhe në aplikacionin Kindle. Amazon
              e konverton skedarin, prandaj faqosja mund të duket pak ndryshe.
            </p>
          </section>

          <section aria-labelledby="problem-heading">
            <h2 id="problem-heading" className="font-serif text-2xl font-normal text-primary">
              Libri nuk shkarkohet ose nuk hapet?
            </h2>
            <p className="mt-3">
              Shkruani te{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK_CLASSES}>
                {SUPPORT_EMAIL}
              </a>{" "}
              dhe na tregoni cili libër dhe cila pajisje. {REPLY_PROMISE}
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
