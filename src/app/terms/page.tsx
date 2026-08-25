import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Terms of Service</h1>

      <p className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
        This is placeholder text, not real legal advice. Have a lawyer
        review and adapt it before this platform handles real users or
        real payments.
      </p>

      <div className="mt-8 flex flex-col gap-6 text-foreground/90">
        <section>
          <h2 className="font-serif text-lg font-semibold">
            1. Accepting these terms
          </h2>
          <p className="mt-2">
            By creating an account, you agree to these terms. If you
            don&apos;t agree, don&apos;t use Librum.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            2. Accounts
          </h2>
          <p className="mt-2">
            You&apos;re responsible for keeping your account credentials
            secure and for all activity under your account.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            3. Author content
          </h2>
          <p className="mt-2">
            Authors retain ownership of everything they upload. By
            publishing a book, you grant Librum a license to store,
            display, and deliver it to readers who purchase it. You
            confirm you have the rights to publish and sell the content
            you upload, and that it doesn&apos;t infringe anyone else&apos;s
            rights.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            4. Prohibited content
          </h2>
          <p className="mt-2">
            No content that is illegal, infringes intellectual property
            rights, or that you don&apos;t have the rights to sell.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            5. Payments and fees
          </h2>
          <p className="mt-2">
            Readers pay through Stripe. For each completed sale, the author
            receives {100 - PLATFORM_FEE_PERCENT}% of the price and Librum
            retains {PLATFORM_FEE_PERCENT}% as its platform fee. Payment
            processing is handled by Stripe; Stripe may separately affect
            settlement timing, but Librum doesn&apos;t store card details.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            6. Refunds
          </h2>
          <p className="mt-2">
            When Librum approves a refund for a purchase, the reader&apos;s
            access to the refunded title or bundle may be removed, the
            corresponding author proceeds are reversed, and Librum&apos;s
            corresponding platform fee is also refunded. Librum doesn&apos;t
            promise a specific settlement time for a refund to appear.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            7. Payment disputes and chargebacks
          </h2>
          <p className="mt-2">
            A reader&apos;s bank or card issuer may allow them to dispute a
            payment directly with the issuer rather than through Librum.
            Opening a dispute does not by itself remove access to a
            purchase. If a dispute is ultimately resolved against the
            payment, the reader&apos;s access to the affected purchase may
            be removed, and Librum may recover from the author only the
            remaining economic proceeds the author actually retained from
            that transaction. Librum does not charge the author for
            Librum&apos;s own platform-fee share of a lost dispute, and
            Librum bears the payment processor&apos;s dispute fee under its
            current policy.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            8. Payouts
          </h2>
          <p className="mt-2">
            Stripe handles author payout account onboarding and
            bank-transfer processing. Payout availability and timing
            depend on your Stripe account status and Stripe&apos;s own
            processing schedule.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            9. Termination
          </h2>
          <p className="mt-2">
            Either party can end this relationship at any time. We may
            suspend or remove accounts or content that violate these
            terms.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            10. Disclaimer
          </h2>
          <p className="mt-2">
            Librum is provided &quot;as is,&quot; without warranties of any
            kind.
          </p>
        </section>

        <section>
          <h2 className="font-serif text-lg font-semibold">
            11. Changes to these terms
          </h2>
          <p className="mt-2">
            We may update these terms from time to time. Continued use of
            Librum after a change means you accept the updated terms.
          </p>
        </section>
      </div>
    </main>
  );
}
