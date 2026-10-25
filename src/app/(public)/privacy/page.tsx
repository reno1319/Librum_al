import Link from "next/link";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SellerDetailsBlock } from "@/components/seller-details";
import { isWhatsappContactLive } from "@/lib/contact";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Librum collects, uses, shares and keeps your personal data.",
};

// POLICY PAGES (pipeline item 2, Renato 10-24): LAWYER-REVIEW DRAFT --
// written to Albania's Law 124/2024 on personal data protection; a
// lawyer checks it before buying goes live. The draft status is noted
// here only, not on the public page. Company details come from
// src/lib/seller.ts (4. a). The download record is the download log of
// pipeline item 3 (2. a: published before it ships; buying is off until
// then). STRIPE REMOVAL (item 10, Renato 5. a): the Stripe line is gone
// with the Stripe code; only the owners' own test accounts ever used
// Stripe, and those old records go at the pre-launch cleanup. The
// date must match the month this goes live. TRUST PACK (item 5, 6. a):
// the WhatsApp line shows only while src/lib/contact.ts holds a number,
// the same value that shows the link on Contact. VISITOR STATS (item 6,
// 3. a): the Vercel Web Analytics lines; the date stays October 2026.
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
                Who is responsible for your data
              </h2>
              <p className="mt-2">
                Librum is responsible (the &quot;controller&quot;) for the
                personal data described here, under Albania&apos;s Law No.
                124/2024 on personal data protection.
              </p>
              <SellerDetailsBlock />
              <p className="mt-2">
                For anything about your data, write to{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>
                .
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                What we collect
              </h2>
              <p className="mt-2">
                <strong>Account:</strong> your email address, display name,
                account role (reader or author), profile photo, and other
                profile information you choose to add.
              </p>
              <p className="mt-2">
                <strong>If you buy as a reader:</strong> your purchases,
                wishlist, follows, reviews, any content reports and refund
                requests you send, and a record of each time you download a
                book you bought (the date and time).
              </p>
              <p className="mt-2">
                <strong>If you publish as an author:</strong> the books,
                covers and manuscript files you upload, your pen names and
                public author profile, your rights declarations, and, if you
                add them for payouts, the account holder&apos;s name and
                IBAN.
              </p>
              <p className="mt-2">
                <strong>Payment:</strong> order and payment identifiers and
                payment status from our payment processor, and records of
                any refund or payment dispute. We don&apos;t collect or store
                your card details.
              </p>
              <p className="mt-2">
                <strong>Messages:</strong> the emails
                {isWhatsappContactLive() && " and WhatsApp messages"} you send
                us and our replies.
              </p>
              <p className="mt-2">
                <strong>Technical:</strong> the cookies described below, and
                the ordinary server and request logs (such as IP address,
                browser type and time of request) that our hosting provider
                generates to run the platform. We count how often each book
                page is viewed without linking the count to you. We count
                page visits with Vercel Web Analytics. It uses no cookies,
                doesn&apos;t follow you across other websites, and
                doesn&apos;t tell us who you are. We don&apos;t do device
                fingerprinting or advertising tracking.
              </p>
              <p className="mt-2">
                <strong>Safety:</strong> records of moderation decisions,
                such as a book taken down or an account suspended, and the
                reasons for them.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Why we use it, and on what legal basis
              </h2>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>To provide the service you signed up for</strong>{" "}
                  (performing our contract with you): running your account,
                  selling and delivering books, handling refunds, publishing
                  authors&apos; books and paying authors.
                </li>
                <li>
                  <strong>To meet legal duties</strong>: keeping accounting
                  and tax records, and answering lawful requests from
                  authorities.
                </li>
                <li>
                  <strong>For our legitimate interests</strong>: keeping
                  Librum secure, preventing fraud and unauthorised sharing,
                  keeping evidence for payment disputes (including download
                  records), moderating content, and sending you emails about
                  your account and purchases.
                </li>
              </ul>
              <p className="mt-2">
                We don&apos;t send marketing emails and we don&apos;t make
                decisions about you by automated means alone. If we ever ask
                for your consent for something, you can withdraw it at any
                time.
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
                What others can see
              </h2>
              <p className="mt-2">
                Your reviews show with your display name. Authors are shown
                by their pen name, and an author&apos;s account name stays
                private. Authors see sales of their books, but not who bought
                them.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Who we share it with
              </h2>
              <p className="mt-2">
                We work with a small set of providers who process data for
                us, only to run Librum:
              </p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>Supabase</strong> — authentication, our database,
                  and file storage for covers and manuscripts.
                </li>
                <li>
                  <strong>Vercel</strong> — hosting the website and counting
                  anonymous page visits.
                </li>
                <li>
                  <strong>Resend</strong> — sending emails, such as purchase
                  receipts and sale notifications.
                </li>
                <li>
                  <strong>POK</strong> — payment processing for reader
                  purchases.
                </li>
                <li>
                  <strong>Cloudflare</strong> — forwarding emails sent to
                  support@librum.al.
                </li>
                <li>
                  <strong>Google (Gmail)</strong> — the inbox where we read
                  and answer your emails.
                </li>
                {isWhatsappContactLive() && (
                  <li>
                    <strong>WhatsApp (Meta)</strong> — if you message us on
                    WhatsApp, WhatsApp handles that chat, and we see your
                    phone number and WhatsApp name.
                  </li>
                )}
              </ul>
              <p className="mt-2">
                We may also share data with our accountant and lawyers, and
                with authorities when the law requires it. We don&apos;t sell
                your data.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Data stored outside Albania
              </h2>
              <p className="mt-2">
                Some of these providers store or process data in the European
                Union or the United States. Where a country doesn&apos;t
                offer protection equal to Albania&apos;s, we rely on the
                safeguards Law No. 124/2024 allows, such as standard
                contractual clauses. You can ask us for details.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                How long we keep it
              </h2>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  <strong>Account and profile:</strong> until you delete
                  your account. Deleting it removes your profile and the
                  ordinary access tied to it straight away.
                </li>
                <li>
                  <strong>Purchases, payments, refunds and payouts:</strong>{" "}
                  10 years, as Albania&apos;s accounting rules require, even
                  after you delete your account. Where we can, we remove the
                  link between these records and you.
                </li>
                <li>
                  <strong>Download records:</strong> as long as the purchase
                  record they belong to.
                </li>
                <li>
                  <strong>
                    {isWhatsappContactLive() ? "Emails and WhatsApp chats with us:" : "Emails with us:"}
                  </strong>{" "}
                  up to 2 years after your last message.
                </li>
                <li>
                  <strong>Moderation records:</strong> as long as needed to
                  keep Librum safe and to answer any legal claim.
                </li>
                <li>
                  <strong>Server logs:</strong> for the short periods our
                  hosting provider keeps them.
                </li>
              </ul>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                How we protect it
              </h2>
              <p className="mt-2">
                Data travels encrypted, staff see only what their role needs,
                and access to your files and records is checked on every
                request. If a breach puts your data at risk, we tell the
                Commissioner within 72 hours and tell you when the risk to you
                is high.
              </p>
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
                Age
              </h2>
              <p className="mt-2">
                You must be at least 16 to make a Librum account, and under
                18 you need a parent&apos;s or guardian&apos;s permission to
                buy. To publish books or receive author payouts, you must be
                at least 18. If we learn that an account belongs to someone
                under 16, we delete it.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Your rights</h2>
              <p className="mt-2">You can ask us to:</p>
              <ul className="mt-2 list-disc pl-5">
                <li>tell you what data we hold about you and give you a copy;</li>
                <li>correct data that is wrong;</li>
                <li>delete your data, where we don&apos;t have to keep it;</li>
                <li>limit how we use it, or stop using it where we rely on our legitimate interests;</li>
                <li>give you the data you gave us in a common digital format.</li>
              </ul>
              <p className="mt-2">
                Write to{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>{" "}
                from your account&apos;s email address. We reply within one
                month. You can also delete your account yourself in your{" "}
                <Link href="/account" className="text-primary underline">
                  account settings
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Complaints
              </h2>
              <p className="mt-2">
                If you think we handle your data wrongly, please tell us
                first. You also have the right to complain to Albania&apos;s
                Commissioner for the Right to Information and Personal Data
                Protection (
                <a href="https://idp.al" className="text-primary underline">
                  idp.al
                </a>
                ).
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Changes to this policy
              </h2>
              <p className="mt-2">
                When we change this policy, we update the date at the top. If
                a change matters to how we use your data, we also tell you by
                email before it applies.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">Contact</h2>
              <p className="mt-2">
                For privacy questions or requests, contact Librum at{" "}
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
