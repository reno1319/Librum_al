import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { MINIMUM_PAID_CATALOG_PRICE_ALL } from "@/lib/catalog-price";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Help",
  description: "Frequently asked questions about publishing and buying ebooks on Librum.",
};

// AUTHOR PAGES REDESIGN: the answers in four groups (Renato's list);
// existing answers are word for word, except that "How do refunds
// work?" lost its legacy Stripe sentence. New: pen name, changing the
// price (written as if paid publishing is live, R2 a -- Edit's own
// message covers the gap until then), why a book is missing from the
// Bookstore, and which rights statement to choose.
const FAQ_GROUPS: { id: string; heading: string; faqs: { q: string; a: string }[] }[] = [
  {
    id: "publishing",
    heading: "Publishing",
    faqs: [
      {
        q: "What file formats can I upload?",
        a: "EPUB, or DOCX (Librum converts it into an EPUB for you), up to 50MB, plus a JPG or PNG cover image up to 5MB.",
      },
      {
        q: "Can I edit a book after publishing it?",
        a: "Yes — from your dashboard, click Edit on any book to change its title, description, genre, price, cover, or manuscript. Replacing the cover or manuscript is optional; leave those fields blank to keep the current file.",
      },
      {
        q: "Can I publish under a pen name?",
        a: "Yes. Each book has an optional \"Pen name\" field under the title.",
      },
      {
        q: "Can I change my price after publishing?",
        a: `Yes. Open Edit on the book and change the price. A paid price is at least ${MINIMUM_PAID_CATALOG_PRICE_ALL} ALL.`,
      },
      {
        q: "Why is my book not in the Bookstore?",
        a: "A book shows in the Bookstore once it is published and has a price. Free counts as a price.",
      },
    ],
  },
  {
    id: "money",
    heading: "Money",
    faqs: [
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
    ],
  },
  {
    id: "buying",
    heading: "Buying and reading",
    faqs: [
      {
        q: "How do refunds work?",
        a: "There's no self-serve refund request yet — reach out from the contact page. The refund process for POK purchases will be published before paid sales launch. Once a refund is processed, you'll lose access to the book automatically (it disappears from downloads, though it stays listed in your library marked as refunded).",
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
    ],
  },
  {
    id: "rights",
    heading: "Rights and reports",
    faqs: [
      {
        q: "Which rights statement should I choose?",
        a: "Your own book, or one you have permission to publish: the first. An old book whose copyright has expired: the second, and only if any translation you upload is also free of copyright.",
      },
      {
        q: "I found a book that shouldn't be on Librum — what do I do?",
        a: "Click \"Report this book\" near the bottom of its page and tell us why. We review every report.",
      },
    ],
  },
];

// Topic links on the green band: the hero's outline-on-dark look.
const TOPIC_LINK_CLASSES =
  "focus-ring inline-flex min-h-11 items-center rounded-[3px] border border-primary-foreground/40 px-4 text-sm font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover";

export default async function HelpPage() {
  const cta = await getAuthorPageCta();

  return (
    <main className="flex-1">
      <PageBand eyebrow="Help" title="Help & FAQ" lead="Answers for authors and readers.">
        <nav aria-label="Help topics" className="mt-6">
          <ul className="flex flex-wrap gap-2.5">
            {FAQ_GROUPS.map((group) => (
              <li key={group.id}>
                <a href={`#${group.id}`} className={TOPIC_LINK_CLASSES}>
                  {group.heading}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageBand>

      <div className={SECTION_CONTAINER}>
        <div className="flex max-w-3xl flex-col gap-12">
          {FAQ_GROUPS.map((group, groupIndex) => (
            <section key={group.id} id={group.id} aria-labelledby={`${group.id}-heading`} className="scroll-mt-6">
              <h2 id={`${group.id}-heading`} className="font-serif text-2xl font-normal text-primary">
                {group.heading}
              </h2>
              <div className="mt-4 border-t border-border">
                {group.faqs.map((faq, i) => (
                  <details
                    key={faq.q}
                    open={groupIndex === 0 && i === 0}
                    className="group border-b border-border"
                  >
                    <summary className="focus-ring flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 rounded-sm py-4 font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                      {faq.q}
                      <span aria-hidden="true" className="font-serif text-2xl leading-none font-normal text-[#8a6d12]">
                        <span className="group-open:hidden">+</span>
                        <span className="hidden group-open:inline">&ndash;</span>
                      </span>
                    </summary>
                    <p className="max-w-[65ch] pb-5 leading-relaxed text-foreground/90">{faq.a}</p>
                  </details>
                ))}
              </div>
            </section>
          ))}

          <p className="text-sm text-muted">
            Didn&apos;t find your answer?{" "}
            <Link href="/contact" className="text-primary underline">
              Get in touch
            </Link>
            .
          </p>
        </div>
      </div>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
