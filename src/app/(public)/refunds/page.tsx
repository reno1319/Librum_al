import Link from "next/link";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SellerDetailsBlock } from "@/components/seller-details";
import { POLICY_LAST_UPDATED_LINE } from "@/lib/policy-dates";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Politika e rimbursimit",
  description: "Kur mund t'i merrni paratë mbrapsht për një libër elektronik të Librum, dhe si ta kërkoni.",
};

// REFUND POLICY (Renato, 10-19: refunds for problems, reply within 5
// working days, no fixed time limit for problems). Same look as the
// Privacy page: green header band, no closing band. Only email is
// offered as the way to ask: the purchases page's "Request refund"
// button exists for Stripe orders only.
//
// POLICY PAGES (pipeline item 2, Renato 10-24): LAWYER-REVIEW DRAFT --
// noted here only, not on the public page. Adds the 14-day cancel right
// of Law 50/2025 until the first download (1. a), bundles only when no
// book in them was downloaded (3. a), and the company details from
// src/lib/seller.ts (4. a). "Downloaded" is read from the download log
// of pipeline item 3, and the checkout agreement ships with the live
// POK build; buying stays off until both exist (2. a).
//
// ALBANIAN-14 (Renato 10-28: 1. a, 3. b, 4. a): the Albanian text is the
// only one, sentence for sentence; the date comes from
// src/lib/policy-dates.ts and is set to the release day.
export default function RefundsPage() {
  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Kushtet dhe privatësia"
        title="Politika e rimbursimit"
        lead="Kjo faqe shpjegon kur mund t'i merrni paratë mbrapsht për një libër elektronik të blerë në Librum."
      />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">{POLICY_LAST_UPDATED_LINE}</p>

          <div className="mt-8 flex flex-col gap-8 text-foreground/90">
            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Anulimi brenda 14 ditëve
              </h2>
              <p className="mt-2">
                Mund ta anuloni një blerje për çfarëdo arsye brenda 14
                ditëve nga blerja, për sa kohë nuk e keni shkarkuar ende
                librin.
              </p>
              <p className="mt-2">
                Para se të paguani, ju kërkohet të pranoni që libri
                dorëzohet menjëherë në bibliotekën tuaj dhe që e humbni këtë
                të drejtë anulimi kur e shkarkoni për herë të parë. Emaili i
                konfirmimit të blerjes e përsërit këtë.
              </p>
              <p className="mt-2">
                Një paketë mund të anulohet vetëm nëse asnjë nga librat e
                saj nuk është shkarkuar.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Probleme me një libër
              </h2>
              <p className="mt-2">
                Në çdo kohë, edhe pasi ta keni shkarkuar librin, jua
                rimbursojmë blerjen nëse:
              </p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  libri nuk u shfaq kurrë në bibliotekën tuaj, ose
                  shkarkimi nuk funksionon;
                </li>
                <li>
                  skedari është i dëmtuar ose nuk hapet, dhe nuk mund
                  t&apos;jua rregullojmë;
                </li>
                <li>
                  u tarifuat dy herë për të njëjtin libër, ose u tarifuat me
                  shumë të gabuar;
                </li>
                <li>
                  dikush e bleu me kartën ose me llogarinë tuaj pa lejen
                  tuaj.
                </li>
              </ul>
              <p className="mt-2">Na tregoni sapo ta vini re problemin.</p>
              <p className="mt-2">
                Përveç këtyre problemeve, nuk e rimbursojmë një libër pasi ta
                keni shkarkuar. Për librat falas nuk ka asgjë për
                t&apos;u rimbursuar.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Si ta kërkoni
              </h2>
              <p className="mt-2">
                Na shkruani te{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>{" "}
                nga adresa e emailit e llogarisë suaj, me titullin e librit,
                datën e blerjes, dhe ose &quot;Dua ta anuloj&quot; ose çfarë
                shkoi keq. Përgjigjemi brenda 5 ditëve të punës.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Çfarë ndodh më pas
              </h2>
              <p className="mt-2">
                Nëse anuloni brenda 14 ditëve, jua kthejmë paratë brenda 14
                ditëve nga kërkesa juaj. Për rimbursimet e tjera, jua
                kthejmë pasi ta miratojmë kërkesën tuaj.
              </p>
              <p className="mt-2">
                Ju kthejmë shumën që paguat, zakonisht në kartën me të cilën
                paguat, përmes ofruesit tonë të pagesave POK. Sa kohë duhet
                që shuma të shfaqet në pasqyrën tuaj e vendos banka juaj.
                Aksesi juaj te libri ose paketa e rimbursuar mund të hiqet.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Kundërshtimet te banka juaj
              </h2>
              <p className="mt-2">
                Mund ta kundërshtoni një pagesë edhe te banka juaj. Hapja e
                një kundërshtimi nuk jua heq aksesin. Nëse banka vendos
                kundër pagesës, aksesi juaj te ai libër mund të hiqet.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Kush jua shet librat
              </h2>
              <SellerDetailsBlock />
              <p className="mt-2">
                Rregullat e plota janë te{" "}
                <Link href="/terms" className="text-primary underline">
                  Kushtet e përdorimit
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Kontakti
              </h2>
              <p className="mt-2">
                Keni pyetje për këtë politikë? Na shkruani te{" "}
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
