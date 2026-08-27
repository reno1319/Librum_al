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
  "The rest is transferred to your bank account by Stripe automatically, per sale — actual timing depends on your Stripe account status and Stripe's own processing schedule.",
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

      {/* LIBRUM 2.0 PRODUCT-4: /pricing previously never mentioned the
          payout-setup requirement at all -- COPY-1's own rule (a paid
          book needs Stripe Connect set up first; a free book never
          does) already lives on Help/How It Works/Dashboard, but not
          here, where an author deciding whether to price a book is
          most likely to want it. Same wording/timing discipline as
          those pages: no specific payout schedule is asserted, because
          none is authoritative in this codebase -- only "per sale,
          timing depends on your Stripe account status." */}
      <h2 className="mt-10 font-serif text-xl font-semibold">Payouts</h2>
      <p className="mt-3 text-foreground/90">
        Paid books require a connected Stripe account — set this up anytime
        from Dashboard &gt; Payouts before you publish your first paid book.
        Stripe verifies your identity and pays you directly; Librum never
        sees or stores your bank details. Free books can be published
        without connecting Stripe at all.
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
