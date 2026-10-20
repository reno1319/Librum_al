import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Librum's Terms of Service.",
};

const AUTHOR_SHARE_PERCENT = 100 - PLATFORM_FEE_PERCENT;

// AUTHOR PAGES REDESIGN: the green header band, a "Contents" box (Renato,
// 1. a) linking each section by its anchor, and gold section numbers.
// No closing band here (Q16 a). The Terms text is unchanged, except a
// sentence in section 8 linking the Refund Policy (/refunds). The
// contents titles must match the section headings below
// (small-fixes-wiring.test.ts checks it).
const SECTION_TITLES = [
  "Acceptance of Terms",
  "Accounts",
  "Librum's role",
  "Author content and license",
  "Content standards and infringement",
  "Marketplace purchases",
  "Payments and platform fee",
  "Refunds",
  "Payment disputes and chargebacks",
  "Author payouts",
  "Unpublishing and withdrawal",
  "Account termination",
  "Availability and platform changes",
  "Disclaimers",
  "Changes to these Terms",
  "Contact",
];

export default function TermsPage() {
  return (
    <main className="flex-1">
      <PageBand eyebrow="Terms and Privacy" title="Terms of Service" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">Last updated: August 2026</p>

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
                Terms. If you don&apos;t agree, don&apos;t use Librum.
              </p>
            </section>

            <section id="section-2" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">2.</span> Accounts
              </h2>
              <p className="mt-2">
                You&apos;re responsible for keeping your account credentials
                secure and for all activity under your account.
              </p>
            </section>

            <section id="section-3" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">3.</span> Librum&apos;s role
              </h2>
              <p className="mt-2">
                Librum is a digital publishing and marketplace platform
                through which independent authors make their work available
                to readers. Librum facilitates the platform itself — book
                listings, payment flow, and digital delivery — and charges a
                platform fee on each sale, as described in Section 7. Paid
                publishing and author payout setup have not launched yet.
              </p>
            </section>

            <section id="section-4" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">4.</span> Author content and license
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
                and to meet legal or accounting obligations — see Section 11.
              </p>
              <p className="mt-2">
                You confirm you have the rights to publish and sell the
                content you upload, and that it doesn&apos;t infringe anyone
                else&apos;s rights.
              </p>
            </section>

            <section id="section-5" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">5.</span> Content standards and infringement
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

            <section id="section-6" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">6.</span> Marketplace purchases
              </h2>
              <p className="mt-2">
                A purchase gives the reader access to download and read the
                digital edition through Librum, subject to these Terms.
              </p>
            </section>

            <section id="section-7" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">7.</span> Payments and platform fee
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

            <section id="section-8" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">8.</span> Refunds
              </h2>
              <p className="mt-2">
                When Librum approves a refund for a purchase, the reader&apos;s
                access to the refunded title or bundle may be removed, the
                corresponding author proceeds are reversed, and Librum&apos;s
                corresponding platform fee is also refunded. Librum
                doesn&apos;t promise a specific settlement time for a refund
                to appear.
              </p>
              <p className="mt-2">
                To find out when and how you can ask for a refund, see our{" "}
                <Link href="/refunds" className="text-primary underline">
                  Refund Policy
                </Link>
                .
              </p>
            </section>

            <section id="section-9" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">9.</span> Payment disputes and chargebacks
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

            <section id="section-10" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">10.</span> Author payouts
              </h2>
              <p className="mt-2">
                Author payout setup is not currently available. Librum will
                publish the applicable payout method and timing before paid
                publishing launches. POK processes new reader payments and is
                not represented here as Librum&apos;s author-payout provider.
              </p>
            </section>

            <section id="section-11" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">11.</span> Unpublishing and withdrawal
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

            <section id="section-12" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">12.</span> Account termination
              </h2>
              <p className="mt-2">
                Either party can end this relationship at any time. We may
                suspend or remove accounts or content that violate these
                terms.
              </p>
              <p className="mt-2">
                For an author, ending an account or removing a work stops
                future sales while existing reader purchases remain protected
                as described in Section 11. For a reader, deleting an account
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

            <section id="section-13" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">13.</span> Availability and platform changes
              </h2>
              <p className="mt-2">
                Librum may change, add, or remove features of the platform
                over time, and doesn&apos;t guarantee that any specific title
                will remain listed or available indefinitely, beyond the
                existing-purchaser protections described in Section 11.
              </p>
            </section>

            <section id="section-14" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">14.</span> Disclaimers
              </h2>
              <p className="mt-2">
                Librum is provided &quot;as is,&quot; without warranties of
                any kind.
              </p>
            </section>

            <section id="section-15" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">15.</span> Changes to these Terms
              </h2>
              <p className="mt-2">
                We may update these terms from time to time. Continued use of
                Librum after a change means you accept the updated terms.
              </p>
            </section>

            <section id="section-16" className="scroll-mt-6">
              <h2 className="font-serif text-xl font-normal text-primary">
                <span className="text-[#8a6d12]">16.</span> Contact
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
