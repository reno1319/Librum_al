import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { computeAuthorSharePercent } from "@/lib/homepage";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import { EarningsCalculator } from "@/components/earnings-calculator";
import { ClosingCtaBand, PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Earnings",
  description: "See Librum's platform fee, author share, and payout information.",
};

const HOW_IT_WORKS = [
  "You set the price for your book — any price you like, including free.",
  `Librum takes a flat ${PLATFORM_FEE_PERCENT}% platform fee on every sale. That's it — no other cuts.`,
  "Paid publishing and author payout setup have not launched yet.",
  "No setup fees, no monthly subscription, no minimum number of sales.",
  "Refunded transactions, or disputes resolved against the payment, are adjusted accordingly.",
];

const SUBHEADING = "font-serif text-2xl font-normal text-primary";

// AUTHOR PAGES REDESIGN (Renato's Q15 a): the green header band with
// today's author share, the calculator in a white two-column box, and
// the three text sections restyled. Every sentence and number is
// unchanged; royalty wording waits for the live POK build.
export default async function PricingPage() {
  const authorSharePercent = computeAuthorSharePercent();
  const cta = await getAuthorPageCta();

  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Earnings"
        title="Earnings"
        lead={
          <>
            You keep {authorSharePercent}% of every sale — Librum keeps{" "}
            {PLATFORM_FEE_PERCENT}%. No setup fees, no monthly subscription, no
            minimum sales. Librum only makes money when you do.
          </>
        }
        aside={
          <div className="border-t border-accent pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-10">
            <span className="block font-serif text-6xl leading-none font-normal sm:text-7xl lg:text-8xl">
              {authorSharePercent}%
            </span>
            <p className="mt-2 text-sm font-medium tracking-wide text-primary-foreground/85 uppercase">
              Author share
            </p>
          </div>
        }
      />

      <section className="bg-background">
        <div className={SECTION_CONTAINER}>
          <EarningsCalculator />
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className={`${SECTION_CONTAINER} grid gap-10 lg:grid-cols-3`}>
          <div>
            <h2 className={SUBHEADING}>How it works</h2>
            <ul className="mt-4 flex list-disc flex-col gap-2 pl-5 leading-relaxed text-foreground/90 marker:text-[#8a6d12]">
              {HOW_IT_WORKS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>

          {/* TRANSITIONAL-PAYMENT-COPY-2 CORRECTION: paid-book publishing and
              author payout setup have not launched yet -- see the approved
              transitional author message. Deliberately does not name POK
              here: POK is only ever named for reader checkout, never as an
              implied author-payout provider. */}
          <div>
            <h2 className={SUBHEADING}>Payouts</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Paid publishing and author payout setup have not launched yet.
              Authors can continue to publish free books without payout setup
              while Librum completes its payment and payout systems.
            </p>
          </div>

          <div>
            <h2 className={SUBHEADING}>What the fee covers</h2>
            <p className="mt-4 leading-relaxed text-foreground/90">
              Hosting, secure checkout, ebook delivery, and watermarking — plus
              every tool in your dashboard: sales analytics, discount codes,
              series, and contributor credits. All included, no extra charge.
            </p>
          </div>
        </div>
      </section>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
