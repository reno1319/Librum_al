import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { RIGHTS_BASES, RIGHTS_STATEMENTS } from "@/lib/rights-statements";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import {
  ClosingCtaBand,
  NUMERAL_CLASSES,
  PageBand,
  SECTION_CONTAINER,
  SECTION_HEADING,
  TEXT_LINK_CLASSES,
} from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Si funksionon",
  description: "Si ta përgatitni, ta publikoni, t'i vini çmimin dhe ta shisni librin tuaj elektronik me Librum.",
};

// FIX1 (X3): each step is numbered once -- by its numeral (01-06), never
// also typed into its title, so readers don't hear "1. 1.".
// AUTHOR PAGES REDESIGN: the steps are a numeral grid, as on the home
// page; step 4 (rights) is new and renders RIGHTS_STATEMENTS, never a
// retyped copy. Every other step's words are unchanged.
const steps: { title: string; body: string; rights?: boolean }[] = [
  {
    title: "Regjistrohuni si autor",
    body: "Krijoni një llogari dhe zgjidhni \"Autor\" kur regjistroheni.",
  },
  {
    title: "Pagesat për autorët",
    body: "Botimi me pagesë dhe pagesat për autorët nuk janë aktivizuar ende. Autorët mund të vazhdojnë të publikojnë libra falas, ndërsa Librum përfundon sistemet e pagesave.",
  },
  {
    title: "Ngarkoni librin tuaj",
    body: "Te Paneli i autorit, shtoni titullin, përshkrimin, zhanrin, çmimin, një kopertinë (JPG ose PNG, deri në 5 MB) dhe dorëshkrimin: një skedar EPUB, ose një skedar DOCX që Librum e kthen në EPUB për ju (në të dyja rastet, deri në 50 MB). Libri ruhet si draft.",
  },
  {
    title: "Zgjidhni deklaratën e të drejtave",
    body: "Para se ta publikoni, zgjidhni atë që është e vërtetë:",
    rights: true,
  },
  {
    title: "Dërgojeni për shqyrtim",
    body: "Kur të jeni gati, dërgojeni draftin për shqyrtim. Pasi Librum ta miratojë, libri shfaqet në Librari dhe në kërkim.",
  },
  {
    title: "Merrni pagesën",
    body: `Kur të nisë botimi me pagesë, sipas kushteve aktuale të komisionit autori merr ${100 - PLATFORM_FEE_PERCENT}% dhe Librum ${PLATFORM_FEE_PERCENT}%. Mënyra dhe koha e pagesave për autorët do të publikohen para se të nisë botimi me pagesë.`,
  },
];

const FILE_GUIDELINES: { heading: string; rows: [string, string][] }[] = [
  {
    heading: "Dorëshkrimi",
    rows: [
      ["Formati", "EPUB, ose DOCX (Librum e kthen në EPUB)"],
      ["Madhësia", "Deri në 50 MB"],
      ["Të tjera", "Pseudonimi dhe përkthyesi janë fusha opsionale"],
    ],
  },
  {
    heading: "Kopertina",
    rows: [
      ["Formati", "JPG ose PNG"],
      ["Madhësia", "Deri në 5 MB"],
      ["Më mirë", "1600 × 2560 px. Të paktën 1000 px e lartë."],
    ],
  },
];

const AFTER_YOU_PUBLISH = [
  { heading: "Seritë", body: "Gruponi librat tuaj sipas radhës së leximit në një faqe serie." },
  { heading: "Kodet e zbritjes", body: "Krijoni kode zbritjeje për nisjen e një libri ose për lexuesit tuaj." },
  { heading: "Ndjekësit", body: "Lexuesit që ju ndjekin marrin një email kur publikoni një libër të ri." },
  { heading: "Pjesë falas", body: "Lexuesit mund të lexojnë falas fillimin e librit tuaj." },
];

export default async function HowItWorksPage() {
  const cta = await getAuthorPageCta();

  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Si funksionon"
        title="Si funksionon vetëbotimi"
        lead={<>Nga regjistrimi deri te pagesa, ja i gjithë procesi.</>}
      />

      <section className="border-b border-border bg-surface">
        <div className={SECTION_CONTAINER}>
          <h2 className={SECTION_HEADING}>Gjashtë hapa</h2>
          <ol className="mt-8 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-2">
                <span className={NUMERAL_CLASSES}>{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-lg font-bold text-primary">{step.title}</h3>
                <p className="text-base leading-relaxed text-muted">{step.body}</p>
                {step.rights && (
                  <ul className="flex flex-col gap-2">
                    {RIGHTS_BASES.map((basis) => (
                      <li
                        key={basis}
                        className="border-l-2 border-accent bg-background px-3 py-2.5 text-[0.9375rem] leading-relaxed text-foreground"
                      >
                        {RIGHTS_STATEMENTS[basis].text}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="bg-background">
        <div className={SECTION_CONTAINER}>
          <h2 className={SECTION_HEADING}>Udhëzime për skedarët</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {FILE_GUIDELINES.map((card) => (
              <div key={card.heading} className="rounded-[4px] border border-border bg-surface p-5 sm:p-6">
                <h3 className="text-lg font-bold text-primary">{card.heading}</h3>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
                  {card.rows.map(([term, value]) => (
                    <div key={term} className="contents">
                      <dt className="text-muted">{term}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className={SECTION_CONTAINER}>
          <h2 className={SECTION_HEADING}>Pasi të publikoni</h2>
          <ul className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {AFTER_YOU_PUBLISH.map((card) => (
              <li key={card.heading}>
                <h3 className="text-lg font-bold text-primary">{card.heading}</h3>
                <p className="mt-2 leading-relaxed text-muted">{card.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="page-container py-10">
        <p className="text-sm text-foreground/90">
          Keni pyetje? Shihni{" "}
          <Link href="/ndihme" className={TEXT_LINK_CLASSES}>
            faqen e ndihmës
          </Link>
          .
        </p>
      </div>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
