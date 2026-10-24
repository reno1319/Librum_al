import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SellerDetailsBlock } from "@/components/seller-details";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Librum's Terms of Service.",
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
const SECTION_TITLES = [
  "Acceptance of Terms",
  "Who we are",
  "Accounts and age",
  "Librum's role",
  "Author content and license",
  "Content standards and infringement",
  "Your reading licence",
  "Payments and platform fee",
  "Cancelling and refunds",
  "Payment disputes and chargebacks",
  "Author payouts",
  "Unpublishing and leaving Librum",
  "Account termination",
  "Availability and platform changes",
  "Disclaimers and liability",
  "Governing law and disputes",
  "Changes to these Terms",
  "Contact",
];

export default function TermsPage() {
  return (
    <main className="flex-1">
      <PageBand eyebrow="Terms and Privacy" title="Terms of Service" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">Last updated: October 2026</p>

          <nav aria-labelledby="terms-contents" className="mt-6 rounded-[4px] border border-border bg-surface p-5 sm:p-6">
            <h2 id="terms-contents" className="text-sm font-semibold uppercase tracking-[0.08em] text-primary">
              Contents
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
                <span className="text-[#8a6d12]">1.</span> Acceptance of Terms
              </h2>
              <p className="mt-2">
                By creating an account or using Librum, you agree to these
                Terms. If you don&apos;t agree, don&apos;t use Librum. How we
                handle personal data is explained in our{" "}
                <Link href="/privacy" className="text-primary underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </section>

            <section id="section-2" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">2.</span> Who we are
              </h2>
              <p className="mt-2">
                Librum is the seller of every book bought on Librum, and the
                other party to these Terms.
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
                <span className="text-[#8a6d12]">3.</span> Accounts and age
              </h2>
              <p className="mt-2">
                You must be at least 16 to make a Librum account. If
                you&apos;re under 18, you need a parent&apos;s or
                guardian&apos;s permission to buy. You must be at least 18
                to publish books on Librum or receive author payouts.
              </p>
              <p className="mt-2">
                You&apos;re responsible for keeping your account credentials
                secure and for all activity under your account.
              </p>
            </section>

            <section id="section-4" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">4.</span> Librum&apos;s role
              </h2>
              <p className="mt-2">
                Librum is a digital publishing and marketplace platform
                through which independent authors make their work available
                to readers. Librum facilitates the platform itself — book
                listings, payment flow, and digital delivery — and charges a
                platform fee on each sale, as described in Section 8. Paid
                publishing and author payout setup have not launched yet.
              </p>
            </section>

            <section id="section-5" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">5.</span> Author content and license
              </h2>
              <p className="mt-2">
                Authors retain ownership of everything they upload. Librum
                does not take ownership of your work.
              </p>
              <p className="mt-2">
                By publishing a book on Librum, you grant Librum a
                non-exclusive, worldwide license to host and store the work,
                display its listing, cover, and metadata, market it within
                Librum, and sell, distribute, and deliver it to readers who
                purchase it — including operating downloads and continued
                access for existing purchasers, processing refunds and
                payment disputes, and keeping the records and backups
                necessary to do all of that.
              </p>
              <p className="mt-2">
                This license lasts for as long as your work or account is
                active on Librum. If you unpublish a work or leave Librum,
                the license continues only as reasonably necessary to keep
                serving readers who already purchased it, to process any
                related refunds or disputes, to maintain records and backups,
                and to meet legal or accounting obligations — see Section 12.
              </p>
              <p className="mt-2">
                When you publish a book, you promise that you are at least
                18 and that:
              </p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  you own the rights to publish and sell it as an ebook, or
                  you have the rights holder&apos;s permission, for the text,
                  the cover and anything else in it;
                </li>
                <li>
                  it doesn&apos;t infringe anyone else&apos;s copyright,
                  trademark or other rights;
                </li>
                <li>
                  it isn&apos;t defamatory, doesn&apos;t break anyone&apos;s
                  privacy, and isn&apos;t otherwise illegal;
                </li>
                <li>the details you give about it (title, author, description) are true.</li>
              </ul>
              <p className="mt-2">
                If one of these promises turns out to be untrue and someone
                makes a claim against Librum because of it, you agree to
                cover Librum&apos;s reasonable costs and losses from that
                claim, including legal fees. Librum will tell you about the
                claim promptly and let you take part in answering it.
              </p>
            </section>

            <section id="section-6" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">6.</span> Content standards and infringement
              </h2>
              <p className="mt-2">
                No content that is illegal, infringes intellectual property
                rights, or that you don&apos;t have the rights to sell.
              </p>
              <p className="mt-2">
                If a rights holder believes a title on Librum infringes their
                rights, they can report it. Librum may temporarily restrict
                or remove the title while it looks into the report, may ask
                the person who reported it and the author for more
                information, and may remove content when that turns out to
                be the right call. Librum may also take further action —
                including removing content or restricting an account — for
                serious or repeated infringement.
              </p>
            </section>

            <section id="section-7" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">7.</span> Your reading licence
              </h2>
              <p className="mt-2">
                When you buy a book, you get a personal licence to download
                it and read it on your own devices, for your own private,
                non-commercial use. You don&apos;t buy the book&apos;s
                copyright or any ownership of the work itself.
              </p>
              <p className="mt-2">
                You may keep copies on your own devices and back them up for
                yourself. You may not share, sell, lend, upload or publish
                the book or copies of it, or remove the personal watermark
                described in our Privacy Policy.
              </p>
              <p className="mt-2">
                If you break these rules, Librum may stop your downloads or
                suspend your account. Your licence can&apos;t be transferred
                to someone else.
              </p>
            </section>

            <section id="section-8" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">8.</span> Payments and platform fee
              </h2>
              <p className="mt-2">
                Librum is currently in pre-launch testing, and paid purchasing
                has not launched publicly. When paid purchasing launches, new
                reader payments will be processed in ALL through POK&apos;s
                hosted checkout page. Librum does not collect or store
                readers&apos; card details. For each completed sale, the
                author receives {AUTHOR_SHARE_PERCENT}% of the amount actually
                charged — after any discount code or bundle pricing is
                applied — and Librum retains {PLATFORM_FEE_PERCENT}% as its
                platform fee.
              </p>
            </section>

            <section id="section-9" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">9.</span> Cancelling and refunds
              </h2>
              <p className="mt-2">
                You can cancel a purchase for any reason within 14 days of
                buying it, as long as you haven&apos;t downloaded the book
                yet. Before you pay, you&apos;re asked to agree that the book
                is delivered to your library straight away and that you lose
                this right to cancel when you first download it. A bundle can
                be cancelled only if none of its books has been downloaded.
              </p>
              <p className="mt-2">
                After that, a refund is still possible if something goes
                wrong with your purchase, as described in our{" "}
                <Link href="/refunds" className="text-primary underline">
                  Refund Policy
                </Link>
                .
              </p>
              <p className="mt-2">
                When Librum approves a refund for a purchase, the reader&apos;s
                access to the refunded title or bundle may be removed, the
                corresponding author proceeds are reversed, and Librum&apos;s
                corresponding platform fee is also refunded. If you cancel
                within the 14 days, Librum sends your money back within 14
                days of your request; how long your bank then takes to show
                it is up to your bank.
              </p>
            </section>

            <section id="section-10" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">10.</span> Payment disputes and chargebacks
              </h2>
              <p className="mt-2">
                A reader&apos;s bank or card issuer may allow them to dispute
                a payment directly with the issuer rather than through
                Librum. Opening a dispute does not by itself remove access to
                a purchase — the consequences below only apply once a
                dispute is resolved against the payment.
              </p>
              <p className="mt-2">
                If a dispute is ultimately resolved against the payment, the
                reader&apos;s access to the affected purchase may be removed,
                and Librum may recover from the author no more than the
                remaining economic proceeds the author actually retained from
                that transaction. Librum does not charge the author for
                Librum&apos;s own platform-fee share of a lost dispute, and
                under Librum&apos;s current policy, Librum bears the payment
                processor&apos;s dispute fee.
              </p>
            </section>

            <section id="section-11" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">11.</span> Author payouts
              </h2>
              <p className="mt-2">
                Author payout setup is not currently available. Librum will
                publish the applicable payout method and timing before paid
                publishing launches. POK processes new reader payments and is
                not represented here as Librum&apos;s author-payout provider.
              </p>
            </section>

            <section id="section-12" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">12.</span> Unpublishing and leaving Librum
              </h2>
              <p className="mt-2">
                An author can unpublish a work or leave Librum at any time.
                Doing so stops future sales of that work, but does not
                retroactively remove access for readers who already
                legitimately purchased it — those readers keep their
                existing access and download rights, subject to refunds,
                payment disputes, legal or takedown requirements, and account
                enforcement where applicable.
              </p>
            </section>

            <section id="section-13" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">13.</span> Account termination
              </h2>
              <p className="mt-2">
                Either party can end this relationship at any time. We may
                suspend or remove accounts or content that violate these
                terms.
              </p>
              <p className="mt-2">
                For an author, ending an account or removing a work stops
                future sales while existing reader purchases remain protected
                as described in Section 12. For a reader, deleting an account
                removes their personal account and the ordinary access tied
                to it; refunds, payment disputes, and any related legal or
                accounting obligations continue to be handled separately, as
                described in our{" "}
                <Link href="/privacy" className="text-primary underline">
                  Privacy Policy
                </Link>
                .
              </p>
            </section>

            <section id="section-14" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">14.</span> Availability and platform changes
              </h2>
              <p className="mt-2">
                Librum may change, add, or remove features of the platform
                over time, and doesn&apos;t guarantee that any specific title
                will remain listed or available indefinitely, beyond the
                existing-purchaser protections described in Section 12.
              </p>
            </section>

            <section id="section-15" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">15.</span> Disclaimers and liability
              </h2>
              <p className="mt-2">
                Beyond the rights the law gives you, Librum is provided
                &quot;as is,&quot; without other warranties. Librum
                doesn&apos;t check or vouch for what authors write in their
                books.
              </p>
              <p className="mt-2">
                For a purchase, Librum&apos;s total liability to you is
                limited to the amount you paid for it. For any other claim,
                it is limited to the total you paid Librum in the 12 months
                before the claim. Librum isn&apos;t liable for losses it
                couldn&apos;t reasonably have foreseen.
              </p>
              <p className="mt-2">
                These limits don&apos;t apply to money Librum owes an author
                under Sections 8 and 11, or to a refund owed under Section 9.
                Nothing in these Terms limits liability that the law
                doesn&apos;t allow to be limited, such as for intent or gross
                negligence, or takes away your rights as a consumer.
              </p>
            </section>

            <section id="section-16" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">16.</span> Governing law and disputes
              </h2>
              <p className="mt-2">
                If you have a complaint, please write to{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>{" "}
                first. We reply within 5 working days and try to settle it
                with you within 30 days. You can also turn to Albania&apos;s
                consumer protection authorities.
              </p>
              <p className="mt-2">
                These Terms are governed by the law of the Republic of
                Albania, and disputes go to the competent court in Tirana. If
                you&apos;re a consumer, this doesn&apos;t take away the
                protection of the mandatory laws of the country where you
                live, or any right you have to bring a claim there.
              </p>
            </section>

            <section id="section-17" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">17.</span> Changes to these Terms
              </h2>
              <p className="mt-2">
                We may update these terms from time to time, and we update
                the date at the top when we do. If a change reduces your
                rights, we tell you by email at least 15 days before it
                applies; other changes apply when they&apos;re posted.
                Continued use of Librum after a change means you accept the
                updated terms. A change never affects a purchase you already
                made.
              </p>
            </section>

            <section id="section-18" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">18.</span> Contact
              </h2>
              <p className="mt-2">
                For questions about these Terms, contact Librum at{" "}
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
