import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How it works",
  description: "Learn how to prepare, publish, price, and sell your ebook with Librum.",
};

// FIX1 (X3): the step numbers come from the numbered list itself, once
// (they were typed into each title as well, so readers heard "1. 1.").
const steps = [
  {
    title: "Sign up as an author",
    body: "Create an account and choose \"Author\" when you sign up.",
  },
  {
    title: "Payout setup",
    body: "Paid publishing and author payout setup have not launched yet. Authors can continue to publish free books while Librum completes its payment and payout systems.",
  },
  {
    title: "Upload your book",
    body: "From your dashboard, add a title, description, genre, price, a cover image (JPG or PNG, up to 5MB), and your manuscript — an EPUB file, or a DOCX file that Librum converts into an EPUB for you (either way, up to 50MB). It's saved as a draft.",
  },
  {
    title: "Publish",
    body: "When you're ready, publish the draft. It immediately appears on the storefront and in search.",
  },
  {
    title: "Get paid",
    body: `When paid publishing launches, the current commission terms allocate ${100 - PLATFORM_FEE_PERCENT}% to the author and ${PLATFORM_FEE_PERCENT}% to Librum. The author payout method and timing will be published before paid publishing launches.`,
  },
];

export default function HowItWorksPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <h1 className="font-serif text-4xl font-normal">
        How self-publishing works
      </h1>
      <p className="mt-3 text-muted">
        From signing up to getting paid, here&apos;s the whole process.
      </p>

      <ol className="mt-8 flex list-decimal flex-col gap-6 pl-6 marker:font-serif marker:text-lg">
        {steps.map((step) => (
          <li key={step.title} className="pl-1">
            <h2 className="font-serif text-lg font-normal">{step.title}</h2>
            <p className="mt-1 text-foreground/90">{step.body}</p>
          </li>
        ))}
      </ol>

      <h2 className="mt-10 font-serif text-xl font-normal">
        File requirements
      </h2>
      <ul className="mt-3 list-disc pl-5 text-foreground/90">
        <li>Manuscript: EPUB, or DOCX (Librum converts it into an EPUB for you), up to 50MB</li>
        <li>Cover image: JPG or PNG, up to 5MB</li>
      </ul>

      <p className="mt-10 text-sm text-muted">
        Ready to start?{" "}
        {/* FIX1 (X2): Author chosen, as on Earnings. */}
        <Link href="/signup?role=author" className="text-primary underline">
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
