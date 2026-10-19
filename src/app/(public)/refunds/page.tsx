import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Refund Policy",
  description: "When you can get your money back for a Librum ebook, and how to ask.",
};

// REFUND POLICY (Renato, 10-19: refunds only for problems, reply within
// 5 working days, no fixed time limit, no seller name/NIPT until the
// NIPT exists). Same look as the Privacy page: green header band, no
// closing band. Only email is offered as the way to ask: the purchases
// page's "Request refund" button exists for Stripe orders only. The
// date must match the month this goes live.
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
                When you can ask for a refund
              </h2>
              <p className="mt-2">We refund a purchase if:</p>
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
                Because ebooks are delivered instantly, we don&apos;t
                otherwise refund a book after it has been delivered to your
                library.
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
                with the title of the book, the date you bought it, and what
                went wrong. We reply within 5 working days.
              </p>
            </section>

            <section>
              <h2 className="font-serif text-xl font-normal text-primary">
                What happens next
              </h2>
              <p className="mt-2">
                If we approve your refund, we return the amount you paid,
                normally to the card you paid with, through our payment
                provider POK. Your bank decides how long it takes to show on
                your statement. Your access to the refunded book or bundle
                may be removed.
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
