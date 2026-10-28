import Link from "next/link";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SellerDetailsBlock } from "@/components/seller-details";
import { isWhatsappContactLive } from "@/lib/contact";
import { POLICY_LAST_UPDATED_LINE } from "@/lib/policy-dates";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Politika e privatësisë",
  description: "Si i mbledh, i përdor, i ndan dhe i ruan Librum të dhënat tuaja personale.",
};

// POLICY PAGES (pipeline item 2, Renato 10-24): LAWYER-REVIEW DRAFT --
// written to Albania's Law 124/2024 on personal data protection; a
// lawyer checks it before buying goes live. The draft status is noted
// here only, not on the public page. Company details come from
// src/lib/seller.ts (4. a). The download record is the download log of
// pipeline item 3 (2. a: published before it ships; buying is off until
// then). STRIPE REMOVAL (item 10, Renato 5. a): the Stripe line is gone
// with the Stripe code; only the owners' own test accounts ever used
// Stripe, and those old records go at the pre-launch cleanup. TRUST
// PACK (item 5, 6. a): the WhatsApp line shows only while
// src/lib/contact.ts holds a number, the same value that shows the link
// on Contact. VISITOR STATS (item 6, 3. a): the Vercel Web Analytics
// lines.
//
// ALBANIAN-14 (Renato 10-28: 1. a, 3. b, 4. a): the Albanian text is the
// only one; the date comes from src/lib/policy-dates.ts and is set to
// the release day. Brought up to date with what the site stores:
// - the download log covers free books too, and which file version was
//   served (DOWNLOADS-1 audit note A);
// - the Terms record and, for authors, the 18+ confirmation, each with
//   its date and version (ITEM 7 audit N5, ITEM 9A audit N4);
// - bank details are described without promising a payout that isn't
//   live (bank setup is off: BANK_PAYOUT_SETUP_ENABLED);
// - emails about new books from authors you follow (ALBANIAN-12).
export default function PrivacyPage() {
  return (
    <main className="flex-1">
      <PageBand eyebrow="Kushtet dhe privatësia" title="Politika e privatësisë" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">{POLICY_LAST_UPDATED_LINE}</p>

          <div className="mt-8 flex flex-col gap-8 text-foreground/90">
            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Kush është përgjegjës për të dhënat tuaja
              </h2>
              <p className="mt-2">
                Librum është përgjegjës (&quot;kontrolluesi&quot;) për të
                dhënat personale të përshkruara këtu, sipas Ligjit nr.
                124/2024 &quot;Për mbrojtjen e të dhënave personale&quot;.
              </p>
              <SellerDetailsBlock />
              <p className="mt-2">
                Për çdo gjë që lidhet me të dhënat tuaja, na shkruani te{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>
                .
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Çfarë mbledhim
              </h2>
              <p className="mt-2">
                <strong>Llogaria:</strong> adresa juaj e emailit, emri që
                shfaqni, roli i llogarisë (lexues ose autor), fotoja e
                profilit dhe informacionet e tjera të profilit që zgjidhni
                të shtoni. Ruajmë edhe datën kur pranuat Kushtet e
                përdorimit dhe cilin version të tyre pranuat, dhe, nëse jeni
                autor, datën kur konfirmuat se jeni 18 vjeç ose më shumë.
              </p>
              <p className="mt-2">
                <strong>Si lexues:</strong> blerjet tuaja dhe librat falas
                që merrni, lista e dëshirave, autorët që ndiqni, vlerësimet,
                çdo raportim përmbajtjeje dhe kërkesë rimbursimi që na
                dërgoni, si dhe një regjistrim për çdo herë që shkarkoni një
                libër që keni blerë ose marrë falas (data, ora dhe cili
                version i skedarit u shkarkua).
              </p>
              <p className="mt-2">
                <strong>Si autor:</strong> librat, kopertinat dhe skedarët e
                dorëshkrimeve që ngarkoni, pseudonimet dhe profili juaj
                publik i autorit, dhe deklaratat tuaja të të drejtave. Nëse
                shtoni të dhënat bankare për pagesat e autorëve (emrin e
                mbajtësit të llogarisë dhe IBAN-in), i ruajmë për t&apos;i
                përdorur kur të nisin këto pagesa.
              </p>
              <p className="mt-2">
                <strong>Pagesat:</strong> identifikuesit e porosisë dhe të
                pagesës dhe gjendjen e pagesës që na dërgon ofruesi ynë i
                pagesave, si dhe regjistrimet e çdo rimbursimi ose
                kundërshtimi pagese. Nuk i mbledhim dhe nuk i ruajmë të
                dhënat e kartës suaj.
              </p>
              <p className="mt-2">
                <strong>Mesazhet:</strong> emailet
                {isWhatsappContactLive() && " dhe mesazhet në WhatsApp"} që
                na dërgoni dhe përgjigjet tona.
              </p>
              <p className="mt-2">
                <strong>Të dhënat teknike:</strong> cookies e përshkruara më
                poshtë, dhe regjistrat e zakonshëm të serverit dhe të
                kërkesave (si adresa IP, lloji i shfletuesit dhe koha e
                kërkesës) që krijon ofruesi ynë i hostimit për të vënë në
                punë platformën. Numërojmë sa herë shikohet faqja e çdo
                libri, pa e lidhur numërimin me ju. Vizitat e faqeve i
                numërojmë me Vercel Web Analytics. Ky shërbim nuk përdor
                cookies, nuk ju ndjek në faqe të tjera interneti dhe nuk na
                tregon kush jeni. Nuk i identifikojmë pajisjet nga
                karakteristikat e tyre (fingerprinting) dhe nuk ju ndjekim
                për reklama.
              </p>
              <p className="mt-2">
                <strong>Siguria:</strong> regjistrimet e vendimeve të
                moderimit, si një libër i hequr nga Libraria ose një llogari
                e pezulluar, dhe arsyet e tyre.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Pse i përdorim dhe mbi çfarë baze ligjore
              </h2>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>Për të ofruar shërbimin për të cilin u regjistruat</strong>{" "}
                  (zbatimi i kontratës sonë me ju): mbajtja e llogarisë suaj,
                  shitja dhe dorëzimi i librave, trajtimi i rimbursimeve,
                  publikimi i librave të autorëve dhe pagesat për autorët.
                </li>
                <li>
                  <strong>Për të përmbushur detyrimet ligjore</strong>:
                  mbajtja e regjistrimeve kontabël dhe tatimore, dhe
                  përgjigjja ndaj kërkesave të ligjshme të autoriteteve.
                </li>
                <li>
                  <strong>Për interesat tona të ligjshme</strong>: mbajtja e
                  sigurisë së Librum, parandalimi i mashtrimit dhe i ndarjes
                  së paautorizuar, ruajtja e provave për kundërshtimet e
                  pagesave (përfshirë regjistrimet e shkarkimeve), moderimi i
                  përmbajtjes, dhe dërgimi i emaileve për llogarinë dhe
                  blerjet tuaja, si dhe për librat e rinj të autorëve që
                  ndiqni.
                </li>
              </ul>
              <p className="mt-2">
                Nuk dërgojmë emaile marketingu dhe nuk marrim vendime për ju
                vetëm me mjete të automatizuara. Nëse ndonjëherë ju kërkojmë
                pëlqimin për diçka, mund ta tërhiqni në çdo kohë.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Shenja personale në skedarët EPUB
              </h2>
              <p className="mt-2">
                Kur një lexues shkarkon një skedar EPUB, Librum mund ta
                vendosë adresën e emailit të llogarisë së tij në të dhënat e
                brendshme të skedarit (metadata), si shenjë personale. Kjo
                shërben për të gjetur kush e shkarkoi një kopje që
                shpërndahet pa leje, dhe për të dekurajuar ndarjen e
                paautorizuar. Nuk është mbrojtje kundër kopjimit, dhe skedari hapet
                normalisht kudo. Pasi shkarkohet, adresa e emailit është
                pjesë e vetë skedarit, jo vetëm diçka e ruajtur në bazën
                tonë të të dhënave.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Çfarë shohin të tjerët
              </h2>
              <p className="mt-2">
                Vlerësimet tuaja shfaqen me emrin që shfaqni. Autorët
                shfaqen me pseudonimin e tyre, dhe emri i llogarisë së një
                autori mbetet privat. Autorët shohin shitjet e librave të
                tyre, por jo kush i bleu.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Me kë i ndajmë
              </h2>
              <p className="mt-2">
                Punojmë me pak ofrues, që i përpunojnë të dhënat për ne
                vetëm për të vënë në punë Librum:
              </p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>Supabase</strong> — hyrja në llogari, baza jonë e
                  të dhënave dhe ruajtja e skedarëve për kopertinat dhe
                  dorëshkrimet.
                </li>
                <li>
                  <strong>Vercel</strong> — hostimi i faqes dhe numërimi
                  anonim i vizitave.
                </li>
                <li>
                  <strong>Resend</strong> — dërgimi i emaileve, si
                  konfirmimet e blerjeve dhe njoftimet për shitjet.
                </li>
                <li>
                  <strong>POK</strong> — përpunimi i pagesave për blerjet e
                  lexuesve.
                </li>
                <li>
                  <strong>Cloudflare</strong> — përcjellja e emaileve të
                  dërguara te support@librum.al.
                </li>
                <li>
                  <strong>Google (Gmail)</strong> — kutia postare ku lexojmë
                  emailet tuaja dhe u përgjigjemi.
                </li>
                {isWhatsappContactLive() && (
                  <li>
                    <strong>WhatsApp (Meta)</strong> — nëse na shkruani në
                    WhatsApp, bisedën e trajton WhatsApp, dhe ne shohim
                    numrin tuaj të telefonit dhe emrin tuaj në WhatsApp.
                  </li>
                )}
              </ul>
              <p className="mt-2">
                Të dhënat mund t&apos;i ndajmë edhe me kontabilistin dhe
                avokatët tanë, si dhe me autoritetet kur e kërkon ligji. Nuk
                i shesim të dhënat tuaja.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Të dhënat e ruajtura jashtë Shqipërisë
              </h2>
              <p className="mt-2">
                Disa nga këta ofrues i ruajnë ose i përpunojnë të dhënat në
                Bashkimin Evropian ose në Shtetet e Bashkuara. Kur një vend
                nuk ofron mbrojtje të barabartë me atë të Shqipërisë,
                mbështetemi te masat mbrojtëse që lejon Ligji nr. 124/2024,
                si klauzolat standarde kontraktuale. Mund të na kërkoni më
                shumë hollësi.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Sa kohë i ruajmë
              </h2>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>Llogaria dhe profili:</strong> derisa ta fshini
                  llogarinë. Fshirja heq menjëherë profilin dhe aksesin e
                  zakonshëm që lidhet me të.
                </li>
                <li>
                  <strong>Blerjet, pagesat, rimbursimet dhe pagesat për autorët:</strong>{" "}
                  10 vjet, siç kërkojnë rregullat kontabël të Shqipërisë,
                  edhe pasi ta fshini llogarinë. Kur është e mundur, e heqim
                  lidhjen mes këtyre regjistrimeve dhe jush.
                </li>
                <li>
                  <strong>Regjistrimet e shkarkimeve:</strong> për aq kohë sa
                  ruhet blerja të cilës i përkasin.
                </li>
                <li>
                  <strong>
                    {isWhatsappContactLive() ? "Emailet dhe bisedat në WhatsApp me ne:" : "Emailet me ne:"}
                  </strong>{" "}
                  deri në 2 vjet pas mesazhit tuaj të fundit.
                </li>
                <li>
                  <strong>Regjistrimet e moderimit:</strong> për aq kohë sa
                  nevojitet për ta mbajtur Librum të sigurt dhe për t&apos;iu
                  përgjigjur çdo pretendimi ligjor.
                </li>
                <li>
                  <strong>Regjistrat e serverit:</strong> për periudhat e
                  shkurtra që i mban ofruesi ynë i hostimit.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Si i mbrojmë
              </h2>
              <p className="mt-2">
                Të dhënat udhëtojnë të enkriptuara, stafi sheh vetëm atë që
                i nevojitet për rolin e tij, dhe aksesi te skedarët dhe
                regjistrimet tuaja kontrollohet në çdo kërkesë. Nëse një
                cenim i sigurisë i vë në rrezik të dhënat tuaja, e njoftojmë
                Komisionerin brenda 72 orëve, dhe ju njoftojmë edhe ju kur
                rreziku për ju është i lartë.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Cookies</h2>
              <p className="mt-2">
                Librum përdor vetëm cookies që nevojiten për funksionimin e
                platformës: një për t&apos;ju mbajtur brenda llogarisë, dhe
                një për ta mbajtur llogarinë tuaj në gjendje të kufizuar
                ndërsa po rivendosni fjalëkalimin, që ky hap të mos
                anashkalohet në mes. Nuk përdorim cookies për reklama ose
                për gjurmim.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Mosha
              </h2>
              <p className="mt-2">
                Duhet të jeni të paktën 16 vjeç për të krijuar një llogari
                në Librum, dhe nën 18 vjeç ju duhet leja e prindit ose e
                kujdestarit për të blerë. Për të publikuar libra ose për të
                marrë pagesa si autor, duhet të jeni të paktën 18 vjeç. Nëse
                mësojmë se një llogari i përket dikujt nën 16 vjeç, e
                fshijmë.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Të drejtat tuaja</h2>
              <p className="mt-2">Mund të na kërkoni:</p>
              <ul className="mt-2 list-disc pl-5">
                <li>t&apos;ju tregojmë cilat të dhëna mbajmë për ju dhe t&apos;ju japim një kopje;</li>
                <li>të korrigjojmë të dhënat që janë të gabuara;</li>
                <li>të fshijmë të dhënat tuaja, kur nuk jemi të detyruar t&apos;i mbajmë;</li>
                <li>të kufizojmë mënyrën si i përdorim, ose të mos i përdorim më kur mbështetemi te interesat tona të ligjshme;</li>
                <li>t&apos;ju japim të dhënat që na keni dhënë, në një format të zakonshëm dixhital.</li>
              </ul>
              <p className="mt-2">
                Na shkruani te{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>{" "}
                nga adresa e emailit e llogarisë suaj. Përgjigjemi brenda
                një muaji. Llogarinë mund ta fshini edhe vetë te{" "}
                <Link href="/account" className="text-primary underline">
                  cilësimet e llogarisë
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Ankesat
              </h2>
              <p className="mt-2">
                Nëse mendoni se i trajtojmë gabim të dhënat tuaja, ju lutemi
                na tregoni fillimisht neve. Keni gjithashtu të drejtë të
                ankoheni te Komisioneri për të Drejtën e Informimit dhe
                Mbrojtjen e të Dhënave Personale (
                <a href="https://idp.al" className="text-primary underline">
                  idp.al
                </a>
                ).
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Ndryshimet e kësaj politike
              </h2>
              <p className="mt-2">
                Kur e ndryshojmë këtë politikë, përditësojmë datën në krye.
                Nëse një ndryshim prek mënyrën si i përdorim të dhënat tuaja,
                ju njoftojmë edhe me email para se të hyjë në fuqi.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Kontakti</h2>
              <p className="mt-2">
                Për pyetje ose kërkesa rreth privatësisë, na shkruani te{" "}
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
