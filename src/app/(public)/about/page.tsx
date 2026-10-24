import Link from "next/link";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SurfaceCard } from "@/components/ui/surface-card";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { visibleTeam } from "@/lib/team";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description: "Librum is a self-publishing platform for digital ebooks, built for Albanian-language authors.",
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

export default async function AboutPage() {
  const cta = await getAuthorPageCta();
  const team = visibleTeam();

  return (
    <main className="flex-1">
      <PageBand eyebrow="About" title="About Librum" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <div className="flex flex-col gap-4 leading-relaxed text-foreground/90">
            <p>
              Librum is a self-publishing platform for digital ebooks. Authors
              upload their work, set their own price, and publish directly to
              readers — no gatekeepers, no submission queue, no waiting for
              approval.
            </p>

            <p>
              We handle the parts that are genuinely hard to do well: secure file
              storage, payment processing, and getting authors paid. Everything
              else — what to write, how to price it, when to publish — stays in
              the author&apos;s hands.
            </p>
          </div>

          <section className="mt-12">
            <h2 className="font-serif text-2xl font-normal text-primary">How the money works</h2>
            <p className="mt-3 text-foreground/90">
              Librum takes a {PLATFORM_FEE_PERCENT}% platform fee on every sale,
              once paid publishing launches. Paid publishing and author payout
              setup have not launched yet — authors can continue to publish
              free books while Librum completes its payment and payout
              systems. See{" "}
              <Link href="/how-it-works" className="text-primary underline">
                how self-publishing works
              </Link>{" "}
              for the full walkthrough.
            </p>
          </section>

          {team.length > 0 && (
            <section className="mt-12" aria-labelledby="team-heading">
              <h2 id="team-heading" className="font-serif text-2xl font-normal text-primary">
                Who we are
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
                <h2 className="font-serif text-lg font-normal text-primary">Questions?</h2>
                <p className="mt-1 text-sm text-foreground/90">
                  Check the{" "}
                  <Link href="/help" className="text-primary underline">
                    help page
                  </Link>{" "}
                  first, or{" "}
                  <Link href="/contact" className="text-primary underline">
                    get in touch
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
