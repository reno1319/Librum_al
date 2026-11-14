import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

// K4 (Kolibër list): an accessibility statement. It names only what the
// site really does today and says plainly what is not checked yet.
export const metadata: Metadata = {
  title: "Aksesueshmëria",
  description: "Si përpiqet Librum të jetë i lehtë për t'u përdorur nga të gjithë, çfarë nuk funksionon ende mirë dhe si të na tregoni për një problem.",
};

const SECTION_HEADING = "font-serif text-xl font-normal text-primary";

export default function AccessibilityPage() {
  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Kushtet dhe privatësia"
        title="Aksesueshmëria"
        lead="Duam që çdo lexues dhe çdo autor ta përdorë Librum pa pengesa, edhe me tastierë, me lexues ekrani ose me zmadhim."
      />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <div className="flex flex-col gap-8 text-foreground/90">
            <section>
              <h2 className={SECTION_HEADING}>Çfarë bëjmë</h2>
              <ul className="mt-2 list-disc pl-5">
                <li>Në krye të çdo faqeje ka një lidhje që ju çon drejt te përmbajtja, pa kaluar menunë.</li>
                <li>Faqja është ndërtuar që të përdoret me tastierë, dhe elementi ku ndodheni shihet qartë.</li>
                <li>Faqet janë shënuar si tekst në shqip, që lexuesit e ekranit t&apos;i lexojnë me shqiptimin e duhur.</li>
                <li>Shumica e butonave kryesorë në telefon janë të paktën 44 piksela, që të shtypen lehtë.</li>
                <li>Te lexuesi i librave mund t&apos;i zmadhoni shkronjat dhe të zgjidhni një faqe të bardhë ose sepia.</li>
                <li>Librat e shkarkuar janë EPUB pa DRM, ndaj mund t&apos;i hapni në aplikacionin e leximit që ju përshtatet më mirë.</li>
              </ul>
            </section>

            <section>
              <h2 className={SECTION_HEADING}>Çfarë nuk funksionon ende mirë</h2>
              <ul className="mt-2 list-disc pl-5">
                <li>Synojmë standardin WCAG 2.2 në nivelin AA, por faqja nuk është kontrolluar ende e plotë kundrejt tij.</li>
                <li>Librat i ngarkojnë autorët. Disa libra mund të kenë figura pa përshkrim ose tituj kapitujsh të pashënuar.</li>
                <li>Disa ngjyra të zbehta teksti mund të jenë të vështira për t&apos;u lexuar.</li>
              </ul>
            </section>

            <section>
              <h2 className={SECTION_HEADING}>Na tregoni</h2>
              <p className="mt-2">
                Nëse diçka ju pengon, na shkruani te{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>
                . Tregoni faqen, pajisjen dhe programin që përdorni. E rregullojmë sa më shpejt që mundemi.
              </p>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
