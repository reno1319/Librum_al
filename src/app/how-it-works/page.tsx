import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How it works",
  description: "Learn how to prepare, publish, price, and sell your ebook with Librum.",
};

const steps = [
  {
    title: "1. Sign up as an author",
    body: "Create an account and choose \"Author\" when you sign up.",
  },
  {
    title: "2. Connect a payout account",
    body: "From Dashboard > Payouts, connect with Stripe. Stripe verifies your identity and collects your bank details directly — Librum never sees or stores them. This is required before you can publish a paid book.",
  },
  {
    title: "3. Upload your book",
    body: "From your dashboard, add a title, description, genre, price, a cover image (JPG or PNG, up to 5MB), and your manuscript — an EPUB file, or a DOCX file that Librum converts into an EPUB for you (either way, up to 50MB). It's saved as a draft.",
  },
  {
    title: "4. Publish",
    body: "When you're ready, publish the draft. It immediately appears on the storefront and in search.",
  },
  {
    title: "5. Get paid",
    body: `Every sale splits automatically: you keep ${100 - PLATFORM_FEE_PERCENT}%, transferred to your bank account by Stripe. Librum keeps a ${PLATFORM_FEE_PERCENT}% platform fee. Actual bank-transfer timing depends on your Stripe account status and Stripe's own processing schedule, and refunded sales, or sales disputed and resolved against the payment, are adjusted accordingly.`,
  },
];

export default function HowItWorksPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">
        How self-publishing works
      </h1>
      <p className="mt-3 text-muted">
        From signing up to getting paid, here&apos;s the whole process.
      </p>

      <ol className="mt-8 flex flex-col gap-6">
        {steps.map((step) => (
          <li key={step.title}>
            <h2 className="font-serif text-lg font-semibold">{step.title}</h2>
            <p className="mt-1 text-foreground/90">{step.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        File requirements
      </h2>
      <ul className="mt-3 list-disc pl-5 text-foreground/90">
        <li>Manuscript: EPUB, or DOCX (Librum converts it into an EPUB for you), up to 50MB</li>
        <li>Cover image: JPG or PNG, up to 5MB</li>
      </ul>

      <p className="mt-10 text-sm text-muted">
        Ready to start?{" "}
        <Link href="/signup" className="text-primary underline">
          Sign up
        </Link>{" "}
        or check the{" "}
        <Link href="/help" className="text-primary underline">
          help page
        </Link>{" "}
        for common questions.
      </p>
    </main>
  );
}
