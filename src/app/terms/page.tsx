import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";

const AUTHOR_SHARE_PERCENT = 100 - PLATFORM_FEE_PERCENT;

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted">Last updated: August 2026</p>

      <div className="mt-8 flex flex-col gap-6 text-foreground/90">
        <section>
          <h2 className="font-serif text-lg font-semibold">
            1. Acceptance of Terms
          </h2>
          <p className="mt-2">
            By creating an account or using Librum, you agree to these
            Terms. If you don&apos;t agree, don&apos;t use Librum.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">2. Accounts</h2>
          <p className="mt-2">
            You&apos;re responsible for keeping your account credentials
            secure and for all activity under your account.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            3. Librum&apos;s role
          </h2>
          <p className="mt-2">
            Librum is a digital publishing and marketplace platform
            through which independent authors make their work available
            to readers. Librum facilitates the platform itself — book
            listings, payment flow, digital delivery, and author payouts
            through Stripe Connect — and charges a platform fee on each
            sale, as described in Section 7.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            4. Author content and license
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

        <section>
          <h2 className="font-serif text-lg font-semibold">
            5. Content standards and infringement
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

        <section>
          <h2 className="font-serif text-lg font-semibold">
            6. Marketplace purchases
          </h2>
          <p className="mt-2">
            A purchase gives the reader access to download and read the
            digital edition through Librum, subject to these Terms.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            7. Payments and platform fee
          </h2>
          <p className="mt-2">
            Readers pay through Stripe. For each completed sale, the
            author receives {AUTHOR_SHARE_PERCENT}% of the amount actually
            charged — after any discount code or bundle pricing is
            applied — and Librum retains {PLATFORM_FEE_PERCENT}% as its
            platform fee. Payment processing is handled by Stripe; Stripe
            may separately affect settlement timing, but Librum
            doesn&apos;t store card details.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">8. Refunds</h2>
          <p className="mt-2">
            When Librum approves a refund for a purchase, the reader&apos;s
            access to the refunded title or bundle may be removed, the
            corresponding author proceeds are reversed, and Librum&apos;s
            corresponding platform fee is also refunded. Librum
            doesn&apos;t promise a specific settlement time for a refund
            to appear.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            9. Payment disputes and chargebacks
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

        <section>
          <h2 className="font-serif text-lg font-semibold">
            10. Author payouts
          </h2>
          <p className="mt-2">
            Stripe Connect handles author payout account onboarding and
            bank-transfer processing. Payout availability depends on your
            Stripe account&apos;s onboarding and status, and settlement
            timing depends on Stripe&apos;s own processing schedule —
            Librum doesn&apos;t guarantee instant or fixed payout timing.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            11. Unpublishing and withdrawal
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

        <section>
          <h2 className="font-serif text-lg font-semibold">
            12. Account termination
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

        <section>
          <h2 className="font-serif text-lg font-semibold">
            13. Availability and platform changes
          </h2>
          <p className="mt-2">
            Librum may change, add, or remove features of the platform
            over time, and doesn&apos;t guarantee that any specific title
            will remain listed or available indefinitely, beyond the
            existing-purchaser protections described in Section 11.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            14. Disclaimers
          </h2>
          <p className="mt-2">
            Librum is provided &quot;as is,&quot; without warranties of
            any kind.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            15. Changes to these Terms
          </h2>
          <p className="mt-2">
            We may update these terms from time to time. Continued use of
            Librum after a change means you accept the updated terms.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            16. Contact
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
    </main>
  );
}
