import Link from "next/link";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SurfaceCard } from "@/components/ui/surface-card";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { visibleTeam } from "@/lib/team";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rreth nesh",
  description: "Librum është një platformë vetëbotimi për libra elektronikë, e krijuar për autorët që shkruajnë shqip.",
};

// LIBRUM 2.0 UI-1: the representative page for the design-system
// foundation -- proves PageHeader, the new --container-content token,
// the warm PAPER/INK palette, and standard section rhythm compose
// correctly on a real page before any other page is touched. Copy is
// unchanged from the pre-UI-1 version; only structure/presentation
// changed. SurfaceCard is used only for the "Questions?" block below,
// which is genuinely card-shaped (a short, distinct call-to-action) --
// the surrounding prose stays plain flowing text, deliberately not
// boxed, to keep the page reading as editorial copy rather than a
// stack of dashboard-style panels.
//
// AUTHOR PAGES REDESIGN: the green header band and the home page's
// closing band (button by visitor, so this page reads auth per request);
// the words are unchanged.
//
// TRUST PACK (pipeline item 5, 3. a and 4. a): "Who we are" renders only
// once src/lib/team.ts holds the team's own words.
//
// ALBANIAN-13 (Renato's a): the first paragraph no longer says "no
// waiting for approval"; every new book waits for Librum's review.

export default async function AboutPage() {
  const cta = await getAuthorPageCta();
  const team = visibleTeam();

  return (
    <main className="flex-1">
      <PageBand eyebrow="Rreth nesh" title="Rreth Librum" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <div className="flex flex-col gap-4 leading-relaxed text-foreground/90">
            <p>
              Librum është një platformë vetëbotimi për libra elektronikë.
              Autorët ngarkojnë veprat e tyre, vendosin vetë çmimin dhe botojnë
              drejtpërdrejt për lexuesit, pa botues ndërmjet. Librum kontrollon
              çdo libër para se të dalë në Librari.
            </p>

            <p>
              Ne merremi me pjesët që janë vërtet të vështira për t&apos;u bërë
              mirë: ruajtjen e sigurt të skedarëve, pagesat e lexuesve dhe
              pagesat për autorët. Gjithçka tjetër (çfarë të shkruani, çfarë
              çmimi t&apos;i vini, kur ta publikoni) mbetet në duart e autorit.
            </p>
          </div>

          <section className="mt-12">
            <h2 className="font-serif text-2xl font-normal text-primary">Si funksionojnë paratë</h2>
            <p className="mt-3 text-foreground/90">
              Kur të nisë botimi me pagesë, Librum do të marrë një tarifë
              platforme prej {PLATFORM_FEE_PERCENT}% për çdo shitje. Botimi me
              pagesë dhe pagesat për autorët nuk janë aktivizuar ende: autorët
              mund të vazhdojnë të publikojnë libra falas, ndërsa Librum
              përfundon sistemet e pagesave. Shihni{" "}
              <Link href="/how-it-works" className="text-primary underline">
                si funksionon vetëbotimi
              </Link>{" "}
              për të gjithë procesin.
            </p>
          </section>

          {team.length > 0 && (
            <section className="mt-12" aria-labelledby="team-heading">
              <h2 id="team-heading" className="font-serif text-2xl font-normal text-primary">
                Kush jemi
              </h2>
              <ul className="mt-4 flex flex-col gap-6">
                {team.map((member) => (
                  <li key={member.name}>
                    <p className="font-semibold text-foreground">{member.name}</p>
                    <p className="text-sm text-muted">{member.role}</p>
                    <p className="mt-1.5 text-foreground/90">{member.bio}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-12">
            <SurfaceCard className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="font-serif text-lg font-normal text-primary">Keni pyetje?</h2>
                <p className="mt-1 text-sm text-foreground/90">
                  Shihni fillimisht{" "}
                  <Link href="/help" className="text-primary underline">
                    faqen e ndihmës
                  </Link>
                  , ose{" "}
                  <Link href="/contact" className="text-primary underline">
                    na kontaktoni
                  </Link>
                  .
                </p>
              </div>
            </SurfaceCard>
          </section>
        </div>
      </div>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
