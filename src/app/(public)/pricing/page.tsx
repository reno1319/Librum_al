import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { computeAuthorSharePercent } from "@/lib/homepage";
import { EarningsCalculator } from "@/components/earnings-calculator";
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

export default function PricingPage() {
  const authorSharePercent = computeAuthorSharePercent();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Earnings</h1>
      <p className="mt-3 text-muted">
        You keep {authorSharePercent}% of every sale — Librum keeps{" "}
        {PLATFORM_FEE_PERCENT}%. No setup fees, no monthly subscription, no
        minimum sales. Librum only makes money when you do.
      </p>

      <div className="mt-8">
        <EarningsCalculator />
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">How it works</h2>
      <ul
        className="mt-3 text-foreground/90"
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        {HOW_IT_WORKS.map((line) => (
          <li key={line}>&middot; {line}</li>
        ))}
      </ul>

      {/* TRANSITIONAL-PAYMENT-COPY-2 CORRECTION: paid-book publishing and
          author payout setup have not launched yet -- see the approved
          transitional author message. Deliberately does not name POK
          here: POK is only ever named for reader checkout, never as an
          implied author-payout provider. */}
      <h2 className="mt-10 font-serif text-xl font-semibold">Payouts</h2>
      <p className="mt-3 text-foreground/90">
        Paid publishing and author payout setup have not launched yet.
        Authors can continue to publish free books without payout setup
        while Librum completes its payment and payout systems.
      </p>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        What the fee covers
      </h2>
      <p className="mt-3 text-foreground/90">
        Hosting, secure checkout, ebook delivery, and watermarking — plus
        every tool in your dashboard: sales analytics, discount codes,
        series, and contributor credits. All included, no extra charge.
      </p>

      <p className="mt-10 text-sm text-muted">
        Ready to start?{" "}
        <Link
          href="/signup?role=author"
          className="text-primary underline"
        >
          Sign up as an author
        </Link>{" "}
        or read{" "}
        <Link href="/how-it-works" className="text-primary underline">
          how self-publishing works
        </Link>
        .
      </p>
    </main>
  );
}
