import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { POLICY_LAST_UPDATED_LINE } from "@/lib/policy-dates";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SellerDetailsBlock } from "@/components/seller-details";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Kushtet e përdorimit",
  description: "Kushtet e përdorimit të Librum.",
};

const AUTHOR_SHARE_PERCENT = 100 - PLATFORM_FEE_PERCENT;

// AUTHOR PAGES REDESIGN: the green header band, a "Contents" box (Renato,
// 1. a) linking each section by its anchor, and gold section numbers.
// No closing band here (Q16 a). The contents titles must match the
// section headings below (small-fixes-wiring.test.ts checks it).
//
// POLICY PAGES (pipeline item 2, Renato 10-24): LAWYER-REVIEW DRAFT --
// noted here only, not on the public page. New: who we are (company
// details from src/lib/seller.ts, 4. a), age 16+ with a parent's OK to
// buy under 18 (5. a), the reader's personal licence, authors' rights
// promises with cover for claims (6. a), authors 18+ (audit Q2 a; not
// yet checked in code), 15 days' notice only for changes that reduce
// rights (audit Q1 a), the 14-day cancel right of Law
// 50/2025 until the first download (1. a, 3. a), liability capped at
// what was paid except money owed to authors and refunds (audit F1),
// and Albanian law with the courts of Tirana. Sections
// 8, 10 and 11 (money, chargebacks, payouts) are word for word as
// before: money wording changes only with the live POK build. The
// checkout agreement in section 9 ships with that build too; buying
// stays off until then.
//
// ALBANIAN-14 (Renato 10-28: 1. a, 2. a, 3. b, 4. a): the Albanian text
// is the only, binding one, and the lawyer checks it before the POK
// review. A new TERMS_VERSION goes with it (src/lib/agreement-records.ts);
// nobody is asked to accept again. Sections 8, 10 and 11 are translated
// sentence for sentence. One fact is brought up to date: section 15 no
// longer says Librum doesn't check books, because every book is
// reviewed before it reaches the Bookstore.
const SECTION_TITLES = [
  "Pranimi i Kushteve",
  "Kush jemi",
  "Llogaritë dhe mosha",
  "Roli i Librum",
  "Përmbajtja e autorit dhe licenca",
  "Rregullat e përmbajtjes dhe shkeljet",
  "Licenca juaj e leximit",
  "Pagesat dhe tarifa e platformës",
  "Anulimi dhe rimbursimet",
  "Kundërshtimet e pagesave",
  "Pagesat për autorët",
  "Heqja nga publikimi dhe largimi nga Librum",
  "Mbyllja e llogarisë",
  "Disponueshmëria dhe ndryshimet e platformës",
  "Garancitë dhe përgjegjësia",
  "Ligji i zbatueshëm dhe mosmarrëveshjet",
  "Ndryshimet e këtyre Kushteve",
  "Kontakti",
];

export default function TermsPage() {
  return (
    <main className="flex-1">
      <PageBand eyebrow="Kushtet dhe privatësia" title="Kushtet e përdorimit" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">{POLICY_LAST_UPDATED_LINE}</p>

          <nav aria-labelledby="terms-contents" className="mt-6 rounded-[4px] border border-border bg-surface p-5 sm:p-6">
            <h2 id="terms-contents" className="text-sm font-semibold uppercase tracking-[0.08em] text-primary">
              Përmbajtja
            </h2>
            <ol className="mt-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
              {SECTION_TITLES.map((title, i) => (
                <li key={title} className="flex gap-2">
                  <span className="w-6 shrink-0 text-right font-serif text-[#8a6d12]">{i + 1}.</span>
                  <a href={`#section-${i + 1}`} className="focus-ring rounded-sm text-primary underline underline-offset-2 hover:decoration-2">
                    {title}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          <div className="mt-10 flex flex-col gap-8 text-foreground/90">
            <section id="section-1" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">1.</span> Pranimi i Kushteve
              </h2>
              <p className="mt-2">
                Duke krijuar një llogari ose duke përdorur Librum, ju
                pranoni këto Kushte. Nëse nuk i pranoni, mos e përdorni
                Librum. Si i trajtojmë të dhënat personale shpjegohet në{" "}
                <Link href="/privatesia" className="text-primary underline">
                  Politikën e privatësisë
                </Link>
                .
              </p>
            </section>

            <section id="section-2" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">2.</span> Kush jemi
              </h2>
              <p className="mt-2">
                Librum është shitësi i çdo libri që blihet në Librum dhe pala
                tjetër e këtyre Kushteve.
              </p>
              <SellerDetailsBlock />
              <p className="mt-2">
                Email:{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>
              </p>
            </section>

            <section id="section-3" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">3.</span> Llogaritë dhe mosha
              </h2>
              <p className="mt-2">
                Duhet të jeni të paktën 16 vjeç për të krijuar një llogari
                në Librum. Nëse jeni nën 18 vjeç, ju duhet leja e prindit ose
                e kujdestarit për të blerë. Duhet të jeni të paktën 18 vjeç
                për të publikuar libra në Librum ose për të marrë pagesa si
                autor.
              </p>
              <p className="mt-2">
                Ju jeni përgjegjës për ruajtjen e sigurt të të dhënave të
                hyrjes në llogarinë tuaj dhe për çdo veprim që kryhet nga
                llogaria juaj.
              </p>
            </section>

            <section id="section-4" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">4.</span> Roli i Librum
              </h2>
              <p className="mt-2">
                Librum është një platformë dixhitale botimi dhe shitjeje,
                përmes së cilës autorët e pavarur ua bëjnë veprat e tyre të
                disponueshme lexuesve. Librum mundëson vetë platformën
                (faqet e librave, procesin e pagesës dhe dorëzimin dixhital)
                dhe merr një tarifë platforme për çdo shitje, siç përshkruhet
                në Seksionin 8. Botimi me pagesë dhe konfigurimi i pagesave
                për autorët nuk kanë nisur ende.
              </p>
            </section>

            <section id="section-5" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">5.</span> Përmbajtja e autorit dhe licenca
              </h2>
              <p className="mt-2">
                Autorët mbeten pronarë të gjithçkaje që ngarkojnë. Librum
                nuk merr pronësinë e veprës suaj.
              </p>
              <p className="mt-2">
                Duke publikuar një libër në Librum, ju i jepni Librum një
                licencë joekskluzive, në mbarë botën, për ta ruajtur veprën,
                për të shfaqur faqen e saj, kopertinën dhe të dhënat e saj,
                për ta promovuar brenda Librum, dhe për ta shitur, shpërndarë
                dhe dorëzuar te lexuesit që e blejnë. Kjo përfshin
                shkarkimet dhe aksesin e vazhdueshëm për blerësit
                ekzistues, trajtimin e rimbursimeve dhe të kundërshtimeve të
                pagesave, si dhe ruajtjen e regjistrimeve dhe të kopjeve
                rezervë që nevojiten për të gjitha këto.
              </p>
              <p className="mt-2">
                Kjo licencë vlen për sa kohë vepra ose llogaria juaj është
                aktive në Librum. Nëse e hiqni një vepër nga publikimi ose
                largoheni nga Librum, licenca vazhdon vetëm për aq sa është e
                arsyeshme për t&apos;u shërbyer lexuesve që e kanë blerë
                tashmë, për të trajtuar rimbursimet ose kundërshtimet
                përkatëse, për të ruajtur regjistrimet dhe kopjet rezervë,
                dhe për të përmbushur detyrimet ligjore ose kontabël (shihni
                Seksionin 12).
              </p>
              <p className="mt-2">
                Kur publikoni një libër, ju premtoni se jeni të paktën 18
                vjeç dhe se:
              </p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  i keni të drejtat për ta publikuar dhe për ta shitur si
                  libër elektronik, ose keni lejen e mbajtësit të të
                  drejtave, për tekstin, kopertinën dhe çdo gjë tjetër që
                  përmban;
                </li>
                <li>
                  libri nuk shkel të drejtën e autorit, markën tregtare ose
                  të drejta të tjera të askujt;
                </li>
                <li>
                  libri nuk është shpifës, nuk cenon privatësinë e askujt
                  dhe nuk është i paligjshëm në ndonjë mënyrë tjetër;
                </li>
                <li>të dhënat që jepni për të (titulli, autori, përshkrimi) janë të vërteta.</li>
              </ul>
              <p className="mt-2">
                Nëse një nga këto premtime rezulton i pavërtetë dhe dikush
                ngre një pretendim kundër Librum për shkak të tij, ju pranoni
                të mbuloni kostot dhe humbjet e arsyeshme të Librum nga ai
                pretendim, përfshirë shpenzimet ligjore. Librum ju njofton
                pa vonesë për pretendimin dhe ju lejon të merrni pjesë në
                përgjigjen ndaj tij.
              </p>
            </section>

            <section id="section-6" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">6.</span> Rregullat e përmbajtjes dhe shkeljet
              </h2>
              <p className="mt-2">
                Nuk lejohet përmbajtje e paligjshme, përmbajtje që shkel të
                drejtat e pronësisë intelektuale, ose përmbajtje që nuk keni
                të drejtë ta shisni.
              </p>
              <p className="mt-2">
                Nëse mbajtësi i të drejtave mendon se një titull në Librum
                shkel të drejtat e tij, mund ta raportojë. Librum mund ta
                kufizojë ose ta heqë përkohësisht titullin ndërsa e shqyrton
                raportimin, mund t&apos;i kërkojë më shumë informacion
                personit që e raportoi dhe autorit, dhe mund ta heqë
                përmbajtjen kur ky rezulton vendimi i duhur. Për shkelje të
                rënda ose të përsëritura, Librum mund të marrë edhe masa të
                tjera, përfshirë heqjen e përmbajtjes ose kufizimin e një
                llogarie.
              </p>
            </section>

            <section id="section-7" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">7.</span> Licenca juaj e leximit
              </h2>
              <p className="mt-2">
                Kur blini një libër, merrni një licencë personale për ta
                shkarkuar dhe për ta lexuar në pajisjet tuaja, për
                përdorimin tuaj privat dhe jo tregtar. Nuk blini të drejtën
                e autorit të librit, as pronësi mbi vetë veprën.
              </p>
              <p className="mt-2">
                Mund të mbani kopje në pajisjet tuaja dhe të bëni kopje
                rezervë për veten. Nuk mund ta ndani, shisni, huazoni,
                ngarkoni ose publikoni librin apo kopjet e tij, dhe nuk mund
                ta hiqni shenjën personale të përshkruar në Politikën e
                privatësisë.
              </p>
              <p className="mt-2">
                Nëse i shkelni këto rregulla, Librum mund t&apos;jua ndalojë
                shkarkimet ose ta pezullojë llogarinë tuaj. Licenca juaj nuk
                mund t&apos;i kalohet dikujt tjetër.
              </p>
            </section>

            <section id="section-8" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">8.</span> Pagesat dhe tarifa e platformës
              </h2>
              <p className="mt-2">
                Librum është aktualisht në testim para nisjes, dhe blerjet
                me pagesë nuk kanë nisur ende publikisht. Kur të nisin
                blerjet me pagesë, pagesat e reja të lexuesve do të
                përpunohen në lekë (ALL) në faqen e pagesës së POK. Librum
                nuk i mbledh dhe nuk i ruan të dhënat e kartave të lexuesve.
                Për çdo shitje të përfunduar, autori merr{" "}
                {AUTHOR_SHARE_PERCENT}% të shumës së paguar realisht, pasi
                zbatohet çdo kod zbritjeje ose çmim pakete, dhe Librum mban{" "}
                {PLATFORM_FEE_PERCENT}% si tarifë të platformës.
              </p>
            </section>

            <section id="section-9" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">9.</span> Anulimi dhe rimbursimet
              </h2>
              <p className="mt-2">
                Mund ta anuloni një blerje për çfarëdo arsye brenda 14
                ditëve nga blerja, për sa kohë nuk e keni shkarkuar ende
                librin. Para se të paguani, ju kërkohet të pranoni që libri
                dorëzohet menjëherë në bibliotekën tuaj dhe që e humbni këtë
                të drejtë anulimi kur e shkarkoni për herë të parë. Një
                paketë mund të anulohet vetëm nëse asnjë nga librat e saj
                nuk është shkarkuar.
              </p>
              <p className="mt-2">
                Pas kësaj, rimbursimi është ende i mundur nëse diçka shkon
                keq me blerjen tuaj, siç përshkruhet në{" "}
                <Link href="/rimbursimet" className="text-primary underline">
                  Politikën e rimbursimit
                </Link>
                .
              </p>
              <p className="mt-2">
                Kur Librum miraton rimbursimin e një blerjeje, aksesi i
                lexuesit te titulli ose paketa e rimbursuar mund të hiqet,
                të ardhurat përkatëse të autorit anulohen, dhe rimbursohet
                edhe tarifa përkatëse e platformës së Librum. Nëse anuloni
                brenda 14 ditëve, Librum jua kthen paratë brenda 14 ditëve
                nga kërkesa juaj; sa kohë i duhet më pas bankës suaj për
                t&apos;i shfaqur varet nga banka.
              </p>
            </section>

            <section id="section-10" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">10.</span> Kundërshtimet e pagesave
              </h2>
              <p className="mt-2">
                Banka ose lëshuesi i kartës së një lexuesi mund t&apos;i
                lejojë të kundërshtojë një pagesë drejtpërdrejt te lëshuesi,
                në vend që ta bëjë përmes Librum. Hapja e një kundërshtimi
                nuk e heq vetvetiu aksesin te një blerje: pasojat më poshtë
                vlejnë vetëm pasi kundërshtimi zgjidhet kundër pagesës.
              </p>
              <p className="mt-2">
                Nëse një kundërshtim zgjidhet përfundimisht kundër pagesës,
                aksesi i lexuesit te blerja përkatëse mund të hiqet, dhe
                Librum mund të rikuperojë nga autori jo më shumë se të
                ardhurat që autori mbajti realisht nga ai transaksion.
                Librum nuk ia ngarkon autorit pjesën e vet të tarifës së
                platformës për një kundërshtim të humbur, dhe sipas
                politikës aktuale të Librum, tarifën e kundërshtimit që merr
                ofruesi i pagesave e paguan Librum.
              </p>
            </section>

            <section id="section-11" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">11.</span> Pagesat për autorët
              </h2>
              <p className="mt-2">
                Konfigurimi i pagesave për autorët nuk është ende i
                disponueshëm. Librum do të publikojë mënyrën dhe kohën e
                pagesave për autorët para se të nisë botimi me pagesë. POK
                përpunon pagesat e reja të lexuesve dhe nuk paraqitet këtu
                si ofruesi që përdor Librum për pagesat e autorëve.
              </p>
            </section>

            <section id="section-12" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">12.</span> Heqja nga publikimi dhe largimi nga Librum
              </h2>
              <p className="mt-2">
                Një autor mund ta heqë një vepër nga publikimi ose të
                largohet nga Librum në çdo kohë. Kjo ndalon shitjet e
                ardhshme të asaj vepre, por nuk ua heq në mënyrë retroaktive
                aksesin lexuesve që e kanë blerë tashmë në mënyrë të
                ligjshme. Këta lexues e ruajnë aksesin dhe të drejtën e
                shkarkimit që kanë, përveç rasteve të rimbursimit, të
                kundërshtimit të pagesës, të kërkesave ligjore ose për
                heqje të përmbajtjes, dhe të masave ndaj llogarisë, kur
                zbatohen.
              </p>
            </section>

            <section id="section-13" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">13.</span> Mbyllja e llogarisë
              </h2>
              <p className="mt-2">
                Secila palë mund ta përfundojë këtë marrëdhënie në çdo kohë.
                Ne mund të pezullojmë ose të heqim llogari ose përmbajtje që
                shkelin këto Kushte.
              </p>
              <p className="mt-2">
                Për një autor, mbyllja e llogarisë ose heqja e një vepre
                ndalon shitjet e ardhshme, ndërsa blerjet ekzistuese të
                lexuesve mbeten të mbrojtura siç përshkruhet në Seksionin
                12. Për një lexues, fshirja e llogarisë heq llogarinë
                personale dhe aksesin e zakonshëm që lidhet me të;
                rimbursimet, kundërshtimet e pagesave dhe çdo detyrim ligjor
                ose kontabël përkatës vazhdojnë të trajtohen veçmas, siç
                përshkruhet në{" "}
                <Link href="/privatesia" className="text-primary underline">
                  Politikën e privatësisë
                </Link>
                .
              </p>
            </section>

            <section id="section-14" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">14.</span> Disponueshmëria dhe ndryshimet e platformës
              </h2>
              <p className="mt-2">
                Librum mund të ndryshojë, të shtojë ose të heqë funksione të
                platformës me kalimin e kohës, dhe nuk garanton që një titull
                i caktuar do të mbetet në Librari ose i disponueshëm
                përgjithmonë, përtej mbrojtjeve për blerësit ekzistues të
                përshkruara në Seksionin 12.
              </p>
            </section>

            <section id="section-15" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">15.</span> Garancitë dhe përgjegjësia
              </h2>
              <p className="mt-2">
                Përtej të drejtave që ju jep ligji, Librum ofrohet
                &quot;siç është&quot;, pa garanci të tjera. Librum e
                shqyrton çdo libër para se të dalë në Librari, por nuk
                garanton atë që autorët shkruajnë në librat e tyre.
              </p>
              <p className="mt-2">
                Për një blerje, përgjegjësia e plotë e Librum ndaj jush
                kufizohet në shumën që paguat për të. Për çdo pretendim
                tjetër, kufizohet në shumën totale që i paguat Librum në 12
                muajt para pretendimit. Librum nuk përgjigjet për humbje që
                nuk mund t&apos;i kishte parashikuar në mënyrë të arsyeshme.
              </p>
              <p className="mt-2">
                Këto kufizime nuk vlejnë për paratë që Librum i detyrohet një
                autori sipas Seksioneve 8 dhe 11, ose për një rimbursim të
                detyruar sipas Seksionit 9. Asgjë në këto Kushte nuk kufizon
                përgjegjësinë që ligji nuk lejon të kufizohet, si për
                veprime me dashje ose për pakujdesi të rëndë, dhe asgjë nuk
                ju heq të drejtat si konsumator.
              </p>
            </section>

            <section id="section-16" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">16.</span> Ligji i zbatueshëm dhe mosmarrëveshjet
              </h2>
              <p className="mt-2">
                Nëse keni një ankesë, ju lutemi na shkruani fillimisht te{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>
                . Përgjigjemi brenda 5 ditëve të punës dhe përpiqemi ta
                zgjidhim me ju brenda 30 ditëve. Mund t&apos;u drejtoheni
                edhe autoriteteve shqiptare për mbrojtjen e konsumatorit.
              </p>
              <p className="mt-2">
                Këto Kushte rregullohen nga ligji i Republikës së
                Shqipërisë, dhe mosmarrëveshjet shqyrtohen nga gjykata
                kompetente në Tiranë. Nëse jeni konsumator, kjo nuk ju heq
                mbrojtjen e ligjeve të detyrueshme të vendit ku jetoni, as
                të drejtën që keni për të ngritur një padi atje.
              </p>
            </section>

            <section id="section-17" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">17.</span> Ndryshimet e këtyre Kushteve
              </h2>
              <p className="mt-2">
                Ne mund t&apos;i përditësojmë këto Kushte herë pas here, dhe
                kur e bëjmë, ndryshojmë datën në krye. Nëse një ndryshim jua
                pakëson të drejtat, ju njoftojmë me email të paktën 15 ditë
                para se të hyjë në fuqi; ndryshimet e tjera hyjnë në fuqi
                kur publikohen. Nëse vazhdoni ta përdorni Librum pas një
                ndryshimi, pranoni Kushtet e përditësuara. Një ndryshim nuk
                prek kurrë një blerje që keni bërë tashmë.
              </p>
            </section>

            <section id="section-18" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">18.</span> Kontakti
              </h2>
              <p className="mt-2">
                Për pyetje rreth këtyre Kushteve, na shkruani te{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>
                .
              </p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
