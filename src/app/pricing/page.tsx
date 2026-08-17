import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { EarningsCalculator } from "@/components/earnings-calculator";

const HOW_IT_WORKS = [
  "You set the price for your book — any price you like, including free.",
  `Librum takes a flat ${PLATFORM_FEE_PERCENT}% platform fee on every sale. That's it — no other cuts.`,
  "The rest is paid straight to your bank account by Stripe, automatically, per sale.",
  "No setup fees, no monthly subscription, no minimum number of sales.",
];

export default function PricingPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Pricing</h1>
      <p className="mt-3 text-muted">
        No setup fees, no monthly subscription, no minimum sales. Librum
        only makes money when you do.
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
