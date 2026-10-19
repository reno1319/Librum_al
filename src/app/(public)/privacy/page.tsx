import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "Librum's Privacy Policy.",
};

// AUTHOR PAGES REDESIGN (Renato's R3 a, R4 a): the green header band,
// no closing band. Text changes: the payment paragraph no longer names
// Stripe for historical transactions, the Stripe bullet keeps only the
// Stripe Connect identifiers Librum still holds (until the later Stripe
// DB step), and the date moves to October 2026 -- it must match the
// month this goes live.
export default function PrivacyPage() {
  return (
    <main className="flex-1">
      <PageBand eyebrow="Terms and Privacy" title="Privacy Policy" />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">Last updated: October 2026</p>

          <div className="mt-8 flex flex-col gap-8 text-foreground/90">
            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                What we collect
              </h2>
              <p className="mt-2">
                <strong>Account:</strong> your email address, display name,
                account role (reader or author), and other profile
                information you choose to add.
              </p>
              <p className="mt-2">
                <strong>If you publish as an author:</strong> the books,
                covers, and manuscript files you upload, and your public
                author profile information. For authors with a historical
                Stripe Connect account, Librum may retain the account
                identifier and historical payout-status records (see &quot;Who
                we share it with&quot; below).
              </p>
              <p className="mt-2">
                <strong>If you buy as a reader:</strong> your purchases,
                wishlist, follows, reviews, and any content reports you
                submit, along with the transaction identifiers tied to each
                purchase.
              </p>
              <p className="mt-2">
                <strong>Payment:</strong> payment or order identifiers and
                payment status from our payment processor for each
                transaction, and records of any refund or payment dispute. We
                don&apos;t collect or store your card details. For new reader
                payments once paid purchasing launches publicly, this
                processor is POK.
              </p>
              <p className="mt-2">
                <strong>Technical:</strong> cookies used to keep you signed in
                and to hold you in a restricted state while a password reset
                is in progress (see &quot;Cookies&quot; below), plus the
                ordinary server and request logs our hosting provider
                generates to run the platform. We don&apos;t do device
                fingerprinting or detailed IP-based tracking of our own.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                EPUB watermarking
              </h2>
              <p className="mt-2">
                When a reader downloads a purchased EPUB, Librum may embed
                that reader&apos;s account email address into the EPUB
                file&apos;s own metadata as a personalized watermark. This is
                meant to trace a leaked copy back to whoever downloaded it,
                as a deterrent against unauthorized sharing — it isn&apos;t
                copy protection, and the file still opens normally everywhere.
                Once downloaded, that email address is part of the file
                itself, not just something stored in our database.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                How we use it
              </h2>
              <p className="mt-2">
                To run your account, process purchases, deliver the books
                you&apos;ve bought, and pay authors for their sales.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Who we share it with
              </h2>
              <p className="mt-2">We work with a small set of providers to run Librum:</p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>Supabase</strong> — authentication, our database,
                  and file storage for covers and manuscripts.
                </li>
                <li>
                  <strong>Stripe</strong> — historical Stripe Connect
                  identifiers and related records.
                </li>
                <li>
                  <strong>POK</strong> — payment processing for new reader
                  purchases, once paid purchasing launches publicly.
                </li>
                <li>
                  <strong>Resend</strong> — sending transactional emails, such
                  as purchase receipts and sale notifications.
                </li>
                <li>
                  <strong>Vercel</strong> — hosting the application.
                </li>
              </ul>
              <p className="mt-2">We don&apos;t sell your data.</p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Cookies</h2>
              <p className="mt-2">
                Librum uses cookies that are necessary to run the platform:
                one to keep you signed in, and one to hold your account in a
                restricted state while a password reset is in progress, so it
                can&apos;t be skipped partway through. We don&apos;t use
                advertising or tracking cookies.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Account deletion
              </h2>
              <p className="mt-2">
                Librum provides account deletion through your account
                settings, where available. Deleting your account removes your
                personal and profile information and the ordinary access tied
                to that account.
              </p>
              <p className="mt-2">
                Some transaction and financial records may need to be
                retained after account deletion where necessary for payment,
                refund, dispute, accounting, fraud prevention, or legal
                purposes. Where appropriate, Librum may remove or minimize the
                association between those records and your account.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Your rights</h2>
              <p className="mt-2">
                Contact Librum if you have questions about, or wish to
                request access to or correction of, personal information
                associated with your account.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Contact</h2>
              <p className="mt-2">
                For privacy questions or requests concerning personal
                information associated with your account, contact Librum at{" "}
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
