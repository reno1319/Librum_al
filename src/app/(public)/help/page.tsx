import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help",
  description: "Frequently asked questions about publishing and buying ebooks on Librum.",
};

const faqs = [
  {
    q: "What file formats can I upload?",
    a: "EPUB, or DOCX (Librum converts it into an EPUB for you), up to 50MB, plus a JPG or PNG cover image up to 5MB.",
  },
  {
    q: "How do I get paid?",
    a: `Paid publishing and author payout setup have not launched yet. Authors can continue to publish free books while Librum completes its payment and payout systems. When paid publishing launches, the current commission terms allocate ${100 - PLATFORM_FEE_PERCENT}% to the author and ${PLATFORM_FEE_PERCENT}% to Librum. The author payout method and timing will be published before paid publishing launches.`,
  },
  {
    q: "What happens to my earnings if a sale is refunded?",
    a: "The corresponding proceeds you received from that sale are reversed, and Librum's platform fee for that sale is refunded too — Librum doesn't keep its fee on a refunded sale.",
  },
  {
    q: "What happens if a buyer wins a chargeback or payment dispute?",
    a: `If a dispute is ultimately resolved against the payment, Librum may recover from you only the remaining proceeds you actually retained from that sale — never more. You're never charged Librum's own ${PLATFORM_FEE_PERCENT}% platform-fee share of a lost dispute, and Librum bears the payment processor's dispute fee under current policy.`,
  },
  {
    q: "Can I edit a book after publishing it?",
    a: "Yes — from your dashboard, click Edit on any book to change its title, description, genre, price, cover, or manuscript. Replacing the cover or manuscript is optional; leave those fields blank to keep the current file.",
  },
  {
    q: "How do refunds work?",
    a: "There's no self-serve refund request yet — reach out from the contact page. Eligible historical Stripe purchases continue to use Librum's legacy Stripe refund process. The refund process for POK purchases will be published before paid sales launch. Once a refund is processed, you'll lose access to the book automatically (it disappears from downloads, though it stays listed in your library marked as refunded).",
  },
  {
    q: "What happens if I dispute a payment with my bank?",
    a: "That's handled through your card or bank's own dispute process, separately from Librum. Opening a dispute doesn't by itself remove your access to the purchase. If the dispute is ultimately resolved against the payment, your access to that purchase may be removed.",
  },
  {
    q: "Is my payment information safe?",
    a: "Librum is currently in pre-launch testing. When paid purchases launch publicly, checkout will take place on POK's hosted payment page and will be charged in ALL — Librum never sees or stores your card details.",
  },
  {
    q: "Can readers preview a book before buying?",
    a: "Yes — click \"Read sample\" on any published book's page for an excerpt from the opening of the book, generated automatically from the manuscript.",
  },
  {
    q: "I found a book that shouldn't be on Librum — what do I do?",
    a: "Click \"Report this book\" near the bottom of its page and tell us why. We review every report.",
  },
];

export default function HelpPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Help &amp; FAQ</h1>

      <dl className="mt-8 flex flex-col gap-6">
        {faqs.map((faq) => (
          <div key={faq.q}>
            <dt className="font-serif font-semibold">{faq.q}</dt>
            <dd className="mt-1 text-foreground/90">{faq.a}</dd>
          </div>
        ))}
      </dl>

      <p className="mt-10 text-sm text-muted">
        Didn&apos;t find your answer?{" "}
        <Link href="/contact" className="text-primary underline">
          Get in touch
        </Link>
        .
      </p>
    </main>
  );
}
