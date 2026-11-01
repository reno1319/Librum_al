import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { MINIMUM_PAID_CATALOG_PRICE_ALL } from "@/lib/catalog-price";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { REPLY_PROMISE } from "@/lib/contact";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Ndihmë",
  description: "Pyetjet më të shpeshta për botimin dhe blerjen e librave elektronikë në Librum.",
};

// AUTHOR PAGES REDESIGN: the answers in four groups (Renato's list);
// existing answers are word for word, except that "How do refunds
// work?" lost its legacy Stripe sentence. New: pen name, changing the
// price (written as if paid publishing is live, R2 a -- Edit's own
// message covers the gap until then), why a book is missing from the
// Bookstore, and which rights statement to choose.
//
// TRUST PACK (pipeline item 5): "How do I open a book I downloaded?"
// links to the reader help page (1. a), and the reply promise sits under
// the list (5. a). An answer can end with one link.
//
// ALBANIAN-13 (Renato's a): three answers written before book review
// existed now say what the site does: the editing answer adds that a
// new cover or file waits for Librum's approval (LIVE_FILES_WARNING),
// and "not in the Bookstore" names the review.
type Faq = { q: string; a: string; link?: { href: string; label: string } };

const FAQ_GROUPS: { id: string; heading: string; faqs: Faq[] }[] = [
  {
    id: "publishing",
    heading: "Botimi",
    faqs: [
      {
        q: "Çfarë skedarësh mund të ngarkoj?",
        a: "EPUB, ose DOCX (Librum e kthen në EPUB për ju), deri në 50 MB, si dhe një kopertinë JPG ose PNG deri në 5 MB.",
      },
      {
        q: "A mund ta ndryshoj një libër pasi e kam publikuar?",
        a: "Po. Te Paneli i autorit, shtypni \"Ndryshoni\" te libri për të ndryshuar titullin, përshkrimin, zhanrin, çmimin, kopertinën ose dorëshkrimin. Kopertina dhe dorëshkrimi i ri janë opsionalë: lërini bosh ato fusha për të mbajtur skedarët e tanishëm. Nëse ndryshoni kopertinën, skedarin e librit ose autorin origjinal, libri del nga Libraria derisa Librum ta miratojë. Ndryshimet e tjera dalin menjëherë.",
      },
      {
        q: "A mund të botoj me pseudonim?",
        a: "Po. Çdo libër ka fushën opsionale \"Pseudonimi\" poshtë titullit.",
      },
      {
        // A4 (Renato 5b): where an Albanian author gets an ISBN.
        q: "Ku ta marr numrin ISBN për librin tim?",
        a: "Në Shqipëri, numrin ISBN e jep Biblioteka Kombëtare e Shqipërisë. Libri elektronik duhet të ketë numrin e vet ISBN, të ndryshëm nga ai i librit të shtypur. Për të botuar në Librum nuk ju duhet ISBN: fusha \"ISBN\" është opsionale.",
      },
      {
        q: "A mund ta ndryshoj çmimin pasi e kam publikuar?",
        a: `Po. Hapni \"Ndryshoni\" te libri dhe ndryshoni çmimin. Një çmim me pagesë është të paktën ${MINIMUM_PAID_CATALOG_PRICE_ALL} lekë.`,
      },
      {
        q: "Pse libri im nuk është në Librari?",
        a: "Një libër shfaqet në Librari pasi e dërgoni për shqyrtim, Librum e miraton dhe libri ka një çmim. Edhe \"Falas\" llogaritet si çmim.",
      },
    ],
  },
  {
    id: "money",
    heading: "Paratë",
    faqs: [
      {
        q: "Si paguhem?",
        a: `Botimi me pagesë dhe pagesat për autorët nuk janë aktivizuar ende. Autorët mund të vazhdojnë të publikojnë libra falas, ndërsa Librum përfundon sistemet e pagesave. Kur të nisë botimi me pagesë, sipas kushteve aktuale të komisionit autori merr ${100 - PLATFORM_FEE_PERCENT}% dhe Librum ${PLATFORM_FEE_PERCENT}%. Mënyra dhe koha e pagesave për autorët do të publikohen para se të nisë botimi me pagesë.`,
      },
      {
        q: "Çfarë ndodh me fitimet e mia nëse një shitje rimbursohet?",
        a: "Të ardhurat që morët nga ajo shitje anulohen, dhe rimbursohet edhe tarifa e platformës së Librum për atë shitje: Librum nuk e mban tarifën e vet për një shitje të rimbursuar.",
      },
      {
        q: "Çfarë ndodh nëse një blerës fiton një kundërshtim të pagesës?",
        a: `Nëse kundërshtimi zgjidhet përfundimisht kundër pagesës, Librum mund të rikuperojë nga ju vetëm të ardhurat që mbajtët realisht nga ajo shitje, asnjëherë më shumë. Nuk paguani kurrë pjesën prej ${PLATFORM_FEE_PERCENT}% të tarifës së platformës së Librum për një kundërshtim të humbur, dhe sipas rregullave aktuale Librum paguan vetë tarifën që merr për kundërshtimin ofruesi i pagesave.`,
      },
    ],
  },
  {
    id: "buying",
    heading: "Blerja dhe leximi",
    faqs: [
      {
        q: "Si ta hap një libër që kam shkarkuar?",
        a: "Librat e Librum janë skedarë EPUB pa DRM. Hapen në Apple Books, Google Play Books dhe në shumicën e aplikacioneve të tjera të leximit, ndërsa Kindle i merr përmes shërbimit Send to Kindle të Amazon.",
        link: { href: "/ndihme/leximi", label: "Si ta lexoni librin tuaj, hap pas hapi" },
      },
      {
        q: "Si funksionojnë rimbursimet?",
        a: "Ende nuk mund ta kërkoni vetë një rimbursim në faqe: na shkruani nga faqja e kontaktit. Procesi i rimbursimit për blerjet me POK do të publikohet para se të nisin shitjet me pagesë. Pasi rimbursimi kryhet, humbni automatikisht aksesin te libri (nuk mund ta shkarkoni më, por mbetet në bibliotekën tuaj me shënimin që është rimbursuar).",
      },
      {
        q: "Çfarë ndodh nëse e kundërshtoj një pagesë te banka ime?",
        a: "Kjo trajtohet nga procedura e kundërshtimit e kartës ose e bankës suaj, veçmas nga Librum. Hapja e një kundërshtimi nuk jua heq vetvetiu aksesin te blerja. Nëse kundërshtimi zgjidhet përfundimisht kundër pagesës, aksesi te ajo blerje mund t'ju hiqet.",
      },
      {
        q: "A janë të sigurta të dhënat e pagesës sime?",
        a: "Librum është tani në testim, para nisjes. Kur të nisin blerjet me pagesë, pagesa do të bëhet në faqen e pagesës së POK dhe do të tarifohet në lekë. Librum nuk i sheh dhe nuk i ruan kurrë të dhënat e kartës suaj.",
      },
      {
        q: "A mund ta shohin lexuesit një pjesë të librit para se ta blejnë?",
        a: "Po. Shtypni \"Lexoni një pjesë\" në faqen e çdo libri të publikuar për të lexuar fillimin e librit, të marrë automatikisht nga dorëshkrimi.",
      },
    ],
  },
  {
    id: "rights",
    heading: "Të drejtat dhe raportimet",
    faqs: [
      {
        q: "Cilën deklaratë të të drejtave duhet të zgjedh?",
        a: "Për librin tuaj, ose për një libër që keni leje ta publikoni: të parën. Për një libër të vjetër, të cilit i ka skaduar e drejta e autorit: të dytën, dhe vetëm nëse edhe përkthimi që ngarkoni nuk mbrohet më nga e drejta e autorit.",
      },
      {
        q: "Gjeta një libër që nuk duhet të jetë në Librum. Çfarë të bëj?",
        a: "Shtypni \"Raportoni këtë libër\" pranë fundit të faqes së tij dhe na tregoni arsyen. E shqyrtojmë çdo raportim.",
      },
    ],
  },
];

// Topic links on the green band: the hero's outline-on-dark look.
const TOPIC_LINK_CLASSES =
  "focus-ring inline-flex min-h-11 items-center rounded-[3px] border border-primary-foreground/40 px-4 text-sm font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover";

export default async function HelpPage() {
  const cta = await getAuthorPageCta();

  return (
    <main className="flex-1">
      <PageBand eyebrow="Ndihmë" title="Ndihmë dhe pyetje të shpeshta" lead="Përgjigje për autorët dhe lexuesit.">
        <nav aria-label="Temat e ndihmës" className="mt-6">
          <ul className="flex flex-wrap gap-2.5">
            {FAQ_GROUPS.map((group) => (
              <li key={group.id}>
                <a href={`#${group.id}`} className={TOPIC_LINK_CLASSES}>
                  {group.heading}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageBand>

      <div className={SECTION_CONTAINER}>
        <div className="flex max-w-3xl flex-col gap-12">
          {FAQ_GROUPS.map((group, groupIndex) => (
            <section key={group.id} id={group.id} aria-labelledby={`${group.id}-heading`} className="scroll-mt-6">
              <h2 id={`${group.id}-heading`} className="font-serif text-2xl font-normal text-primary">
                {group.heading}
              </h2>
              <div className="mt-4 border-t border-border">
                {group.faqs.map((faq, i) => (
                  <details
                    key={faq.q}
                    open={groupIndex === 0 && i === 0}
                    className="group border-b border-border"
                  >
                    <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-4 font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                      {faq.q}
                      <span aria-hidden="true" className="font-serif text-2xl leading-none font-normal text-[#8a6d12]">
                        <span className="group-open:hidden">+</span>
                        <span className="hidden group-open:inline">&ndash;</span>
                      </span>
                    </summary>
                    <p className="max-w-[65ch] pb-5 leading-relaxed text-foreground/90">
                      {faq.a}
                      {faq.link && (
                        <>
                          {" "}
                          <Link href={faq.link.href} className="text-primary underline">
                            {faq.link.label}
                          </Link>
                          .
                        </>
                      )}
                    </p>
                  </details>
                ))}
              </div>
            </section>
          ))}

          <p className="text-sm text-muted">
            Nuk e gjetët përgjigjen?{" "}
            <Link href="/kontakt" className="text-primary underline">
              Na kontaktoni
            </Link>
            . {REPLY_PROMISE}
          </p>
        </div>
      </div>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
