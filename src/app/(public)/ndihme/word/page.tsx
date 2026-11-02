import Link from "next/link";
import { BRASS_CTA_CLASSES, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { REPLY_PROMISE, SUPPORT_EMAIL } from "@/lib/contact";
import { WORD_TEMPLATE_PATH } from "@/lib/word-guide-paths";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Si ta përgatitni dorëshkrimin në Word",
  description:
    "Rregullat që ndjek Librum kur e kthen një dorëshkrim Word (.docx) në libër elektronik, si dhe shablloni i Librum për ta shkarkuar.",
};

// BD6 (Renato's answers 1 Nov: 1a its own page with the template ready
// to download, 2a the template mirrors the converter, 4a only the
// support email, 5b Word steps only). Every rule here is what the
// converter does today (docx-converter.ts, docx-structure.ts,
// docx-notes.ts, ebook-preview.tsx); word-template.test.ts checks the
// facts that can drift.

const LINK_CLASSES = "text-primary underline";

const RULES: { id: string; heading: string; text: string }[] = [
  {
    id: "kapitujt",
    heading: "Kapitujt: stili Heading 1",
    text:
      "Vendosni stilin Heading 1 te titulli i çdo kapitulli (Home › Styles › Heading 1). Çdo Heading 1 e nis një kapitull të ri në faqe të re dhe bëhet një rresht te përmbajtja e librit. Mos e përdorni Heading 1 për asgjë tjetër. Nëse nuk e përdorni fare, Librum përpiqet t’i gjejë vetë kapitujt sipas pamjes së titujve, dhe ju i kontrolloni në pamjen paraprake.",
  },
  {
    id: "nentitujt",
    heading: "Nëntitujt: stili Heading 2",
    text:
      "Për një nëntitull brenda kapitullit përdorni stilin Heading 2. Kur libri ka kapituj me Heading 1, nëntitulli nuk e ndan librin në kapituj. Nëse libri nuk ka asnjë Heading 1 dhe ka disa tituj me Heading 2, Librum i merr ata si kapituj.",
  },
  {
    id: "paragrafet",
    heading: "Paragrafët",
    text:
      "Në fund të paragrafit shtypni Enter vetëm një herë. Mos vendosni Tab ose hapësira në fillim të paragrafit dhe mos lini rreshta bosh për të krijuar hapësirë. Librum e vendos vetë kryeradhën dhe hapësirën midis paragrafëve.",
  },
  {
    id: "ndarja",
    heading: "Ndarja e skenës",
    text: "Shkruani * * * në një rresht më vete. Në libër del në qendër.",
  },
  {
    id: "shenimet",
    heading: "Shënimet",
    text:
      "Përdorni shënimet e vetë Word-it: References › Insert Footnote ose References › Insert Endnote. Mos i shkruani numrat e shënimeve me dorë. Shënimet në fund të faqes (Footnote) dalin në fund të kapitullit të tyre, ndërsa shënimet në fund të librit (Endnote) dalin në kapitullin “Shënime”. Në shumicën e aplikacioneve të leximit, lexuesi i hap me një prekje.",
  },
  {
    id: "poezia",
    heading: "Poezia",
    text:
      "Brenda strofës, në fund të çdo vargu shtypni Shift+Enter; në fund të strofës shtypni Enter. Librum e njeh si poezi një strofë me të paktën tre vargje të shkurtra; strofat me dy vargje ose me vargje shumë të gjata kontrollojini në pamjen paraprake. Rreshtat e shkurtër të vendosur në qendër (Center), si një moto, mbeten në qendër.",
  },
  {
    id: "formatimi",
    heading: "Shkronjat",
    text:
      "Shkronjat e pjerrëta (italic) dhe të trasha (bold) ruhen. Lloji i shkronjave, madhësia dhe ngjyra nuk ruhen, sepse lexuesi i zgjedh vetë në aplikacionin e tij të leximit.",
  },
  {
    id: "figurat",
    heading: "Figurat",
    text:
      "Futni figurat me Insert › Pictures, në format PNG, JPEG ose GIF, deri në 15 MB secila dhe 40 MB gjithsej. Figurat në formate të tjera (si BMP ose TIFF), si dhe vizatimet dhe grafikët e Word-it, lihen jashtë.",
  },
];

const LEAVE_OUT: string[] = [
  "Faqen e titullit dhe faqen e të drejtave të autorit (©): Librum i bën vetë nga të dhënat e librit;",
  "Tabelën e përmbajtjes: Librum e ndërton vetë nga titujt e kapitujve;",
  "Numrat e faqeve, kokën dhe fundin e faqes (Header, Footer): një libër elektronik nuk ka faqe fikse;",
  "Kutitë e tekstit (Text Box): teksti i tyre zhvendoset pas paragrafit ku ndodhen;",
  // Renato 1 Nov (a, from Amazon KDP's ebook rules): Librum already puts
  // the uploaded cover in every ebook (W7), so a pasted one shows twice.
  "Kopertinën: mos e vendosni brenda dorëshkrimit; ngarkojeni veçmas, te fusha “Imazhi i kopertinës”.",
];

export default function WordGuidePage() {
  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Ndihmë për autorët"
        title="Si ta përgatitni dorëshkrimin në Word"
        lead="Librum e kthen skedarin tuaj Word (.docx) në libër elektronik që përshtatet me çdo ekran. Kur dorëshkrimi ndjek këto rregulla, libri del i rregullt dhe në pamjen paraprake nuk keni pothuajse asgjë për të ndrequr."
      >
        <div className="mt-7">
          <a href={WORD_TEMPLATE_PATH} download className={BRASS_CTA_CLASSES}>
            Shkarkoni shabllonin e Librum (.docx)
          </a>
        </div>
      </PageBand>

      <div className={SECTION_CONTAINER}>
        <div className="flex max-w-2xl flex-col gap-10 leading-relaxed text-foreground/90">
          <section id="shablloni" aria-labelledby="template-heading" className="scroll-mt-6">
            <h2 id="template-heading" className="font-serif text-2xl font-normal text-primary">
              Mënyra më e lehtë: shablloni
            </h2>
            <p className="mt-3">
              Shablloni është një libër shembull me dy kapituj. Aty shihni rregullat
              kryesore të kësaj faqeje: titujt e kapitujve, një ndarje skene, një shënim,
              një nëntitull dhe një poezi. Hapeni në Word, fshini tekstin shembull dhe
              shkruani ose ngjitni librin tuaj. Pastaj vendosni stilin Heading 1 te
              titulli i çdo kapitulli.
            </p>
            <p className="mt-3">
              <a href={WORD_TEMPLATE_PATH} download className={LINK_CLASSES}>
                Shkarkoni shabllonin e Librum (.docx)
              </a>
            </p>
          </section>

          <section aria-labelledby="rules-heading">
            <h2 id="rules-heading" className="font-serif text-2xl font-normal text-primary">
              Rregullat
            </h2>
            <p className="mt-3">
              Mund ta përgatitni edhe skedarin tuaj, pa shabllonin, nëse ndiqni këto
              rregulla.
            </p>
            <div className="mt-2 flex flex-col gap-6">
              {RULES.map((rule) => (
                <section key={rule.id} id={rule.id} aria-labelledby={`${rule.id}-heading`} className="scroll-mt-6">
                  <h3 id={`${rule.id}-heading`} className="mt-4 font-serif text-xl font-normal text-primary">
                    {rule.heading}
                  </h3>
                  <p className="mt-2">{rule.text}</p>
                </section>
              ))}
            </div>
          </section>

          <section aria-labelledby="leave-out-heading">
            <h2 id="leave-out-heading" className="font-serif text-2xl font-normal text-primary">
              Çfarë të mos vendosni
            </h2>
            <ul className="mt-3 list-disc pl-5">
              {LEAVE_OUT.map((item) => (
                <li key={item} className="mt-1.5">
                  {item}
                </li>
              ))}
            </ul>
            <p className="mt-3">
              Nëse i keni, Librum heq vetë tabelën e përmbajtjes dhe faqen e të drejtave,
              kurse titullin në faqen e parë, kur e njeh, jua ofron për ta hequr. Këto i
              shihni në pamjen paraprake. Koka dhe fundi i faqes thjesht nuk kalojnë në libër.
            </p>
          </section>

          <section aria-labelledby="before-heading">
            <h2 id="before-heading" className="font-serif text-2xl font-normal text-primary">
              Para se ta ngarkoni
            </h2>
            <ol className="mt-3 list-decimal pl-5">
              <li className="mt-1.5">
                Nëse keni ndryshime të pashqyrtuara ose komente, pranoni ndryshimet (Review ›
                Accept › Accept All Changes) dhe fshini komentet (Review › Delete › Delete
                All Comments in Document).
              </li>
              <li className="mt-1.5">
                Ruajeni si skedar .docx: File › Save As, pastaj zgjidhni Word Document
                (.docx). Librum pranon vetëm .docx, deri në 50 MB.
              </li>
            </ol>
          </section>

          <section aria-labelledby="preview-heading">
            <h2 id="preview-heading" className="font-serif text-2xl font-normal text-primary">
              Pas ngarkimit: pamja paraprake
            </h2>
            <p className="mt-3">
              Librum ju tregon të gjithë librin, kapitull pas kapitulli. Nëse një titull
              nuk u njoh, zgjidhni rreshtin dhe shtypni “Bëje kapitull”. Nëse diçka u bë
              kapitull gabimisht, shtypni “Ky nuk është kapitull”. Pastaj shtypni “Apliko
              ndryshimet”. Libri dërgohet për shqyrtim vetëm pasi të shtypni “E kontrollova,
              libri duket mirë”.
            </p>
          </section>

          <section aria-labelledby="help-heading">
            <h2 id="help-heading" className="font-serif text-2xl font-normal text-primary">
              Keni vështirësi?
            </h2>
            <p className="mt-3">
              Shkruani te{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK_CLASSES}>
                {SUPPORT_EMAIL}
              </a>{" "}
              dhe na tregoni ku ngecët. {REPLY_PROMISE} Përgjigjet e pyetjeve të tjera i gjeni te faqja{" "}
              <Link href="/ndihme" className={LINK_CLASSES}>
                Ndihmë
              </Link>
              .
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
