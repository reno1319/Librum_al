import Link from "next/link";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { SellerDetailsBlock } from "@/components/seller-details";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "When you can get your money back for a Librum ebook, and how to ask.",
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
// POK build; buying stays off until both exist (2. a). The date must
// match the month this goes live.
export default function RefundsPage() {
  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Terms and Privacy"
        title="Refund Policy"
        lead="This page explains when you can get your money back for an ebook bought on Librum."
      />

      <div className={SECTION_CONTAINER}>
        <div className="max-w-2xl">
          <p className="text-sm text-muted">Last updated: October 2026</p>

          <div className="mt-8 flex flex-col gap-8 text-foreground/90">
            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Cancel within 14 days
              </h2>
              <p className="mt-2">
                You can cancel a purchase for any reason within 14 days of
                buying it, as long as you haven&apos;t downloaded the book
                yet.
              </p>
              <p className="mt-2">
                Before you pay, you&apos;re asked to agree that the book is
                delivered to your library straight away and that you lose
                this right to cancel when you first download it. Your
                purchase receipt email confirms this.
              </p>
              <p className="mt-2">
                A bundle can be cancelled only if none of its books has been
                downloaded.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Problems with a book
              </h2>
              <p className="mt-2">
                At any time, including after you&apos;ve downloaded it, we
                refund a purchase if:
              </p>
              <ul className="mt-2 list-disc pl-5">
                <li>
                  the book never appeared in your library, or the download
                  doesn&apos;t work;
                </li>
                <li>
                  the file is damaged or can&apos;t be opened, and we
                  can&apos;t fix it for you;
                </li>
                <li>
                  you were charged twice for the same book, or charged the
                  wrong amount;
                </li>
                <li>
                  someone bought it with your card or account without your
                  permission.
                </li>
              </ul>
              <p className="mt-2">Tell us as soon as you notice the problem.</p>
              <p className="mt-2">
                Apart from these problems, we don&apos;t refund a book after
                you&apos;ve downloaded it. Free books have nothing to refund.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                How to ask
              </h2>
              <p className="mt-2">
                Write to{" "}
                <a href="mailto:support@librum.al" className="text-primary underline">
                  support@librum.al
                </a>{" "}
                from your account&apos;s email address, with the title of the
                book, the date you bought it, and either &quot;I want to
                cancel&quot; or what went wrong. We reply within 5 working
                days.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                What happens next
              </h2>
              <p className="mt-2">
                If you cancel within the 14 days, we send your money back
                within 14 days of your request. For other refunds, we send it
                once we approve your request.
              </p>
              <p className="mt-2">
                We return the amount you paid, normally to the card you paid
                with, through our payment provider POK. Your bank decides how
                long it takes to show on your statement. Your access to the
                refunded book or bundle may be removed.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Disputes with your bank
              </h2>
              <p className="mt-2">
                You can also dispute a payment with your bank. Opening a
                dispute doesn&apos;t remove your access. If the bank decides
                against the payment, your access to that book may be
                removed.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Who sells your books
              </h2>
              <SellerDetailsBlock />
              <p className="mt-2">
                The full rules are in our{" "}
                <Link href="/terms" className="text-primary underline">
                  Terms of Service
                </Link>
                .
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                Contact
              </h2>
              <p className="mt-2">
                Questions about this policy? Write to{" "}
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
