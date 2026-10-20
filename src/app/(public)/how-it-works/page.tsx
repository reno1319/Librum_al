import Link from "next/link";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { RIGHTS_BASES, RIGHTS_STATEMENTS } from "@/lib/rights-statements";
import { getAuthorPageCta } from "@/lib/author-page-cta";
import {
  ClosingCtaBand,
  NUMERAL_CLASSES,
  PageBand,
  SECTION_CONTAINER,
  SECTION_HEADING,
  TEXT_LINK_CLASSES,
} from "@/components/page-bands";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How it works",
  description: "Learn how to prepare, publish, price, and sell your ebook with Librum.",
};

// FIX1 (X3): each step is numbered once -- by its numeral (01-06), never
// also typed into its title, so readers don't hear "1. 1.".
// AUTHOR PAGES REDESIGN: the steps are a numeral grid, as on the home
// page; step 4 (rights) is new and renders RIGHTS_STATEMENTS, never a
// retyped copy. Every other step's words are unchanged.
const steps: { title: string; body: string; rights?: boolean }[] = [
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
    title: "Choose the rights statement",
    body: "Before you publish, pick the one that's true:",
    rights: true,
  },
  {
    title: "Send for review",
    body: "When you're ready, send the draft for review. Once Librum approves it, it appears on the storefront and in search.",
  },
  {
    title: "Get paid",
    body: `When paid publishing launches, the current commission terms allocate ${100 - PLATFORM_FEE_PERCENT}% to the author and ${PLATFORM_FEE_PERCENT}% to Librum. The author payout method and timing will be published before paid publishing launches.`,
  },
];

const FILE_GUIDELINES: { heading: string; rows: [string, string][] }[] = [
  {
    heading: "Manuscript",
    rows: [
      ["Format", "EPUB, or DOCX (Librum converts it to EPUB)"],
      ["Size", "Up to 50 MB"],
      ["Extra", "Pen name and translator are optional fields"],
    ],
  },
  {
    heading: "Cover",
    rows: [
      ["Format", "JPG or PNG"],
      ["Size", "Up to 5 MB"],
      ["Best", "1600 × 2560 px. At least 1000 px tall."],
    ],
  },
];

const AFTER_YOU_PUBLISH = [
  { heading: "Series", body: "Group your books in reading order on one series page." },
  { heading: "Discount codes", body: "Make discount codes for a launch or for your readers." },
  { heading: "Followers", body: "Readers who follow you get an email when you publish a new book." },
  { heading: "Free sample", body: "Readers can read a free sample from the opening of your book." },
];

export default async function HowItWorksPage() {
  const cta = await getAuthorPageCta();

  return (
    <main className="flex-1">
      <PageBand
        eyebrow="How it works"
        title="How self-publishing works"
        lead={<>From signing up to getting paid, here&apos;s the whole process.</>}
      />

      <section className="border-b border-border bg-surface">
        <div className={SECTION_CONTAINER}>
          <h2 className={SECTION_HEADING}>Six steps</h2>
          <ol className="mt-8 grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {steps.map((step, i) => (
              <li key={step.title} className="flex flex-col gap-2">
                <span className={NUMERAL_CLASSES}>{String(i + 1).padStart(2, "0")}</span>
                <h3 className="text-lg font-bold text-primary">{step.title}</h3>
                <p className="text-base leading-relaxed text-muted">{step.body}</p>
                {step.rights && (
                  <ul className="flex flex-col gap-2">
                    {RIGHTS_BASES.map((basis) => (
                      <li
                        key={basis}
                        className="border-l-2 border-accent bg-background px-3 py-2.5 text-[0.9375rem] leading-relaxed text-foreground"
                      >
                        {RIGHTS_STATEMENTS[basis].text}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="bg-background">
        <div className={SECTION_CONTAINER}>
          <h2 className={SECTION_HEADING}>File guidelines</h2>
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {FILE_GUIDELINES.map((card) => (
              <div key={card.heading} className="rounded-[4px] border border-border bg-surface p-5 sm:p-6">
                <h3 className="text-lg font-bold text-primary">{card.heading}</h3>
                <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
                  {card.rows.map(([term, value]) => (
                    <div key={term} className="contents">
                      <dt className="text-muted">{term}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className={SECTION_CONTAINER}>
          <h2 className={SECTION_HEADING}>After you publish</h2>
          <ul className="mt-8 grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
            {AFTER_YOU_PUBLISH.map((card) => (
              <li key={card.heading}>
                <h3 className="text-lg font-bold text-primary">{card.heading}</h3>
                <p className="mt-2 leading-relaxed text-muted">{card.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div className="page-container py-10">
        <p className="text-sm text-foreground/90">
          Questions? See the{" "}
          <Link href="/help" className={TEXT_LINK_CLASSES}>
            help page
          </Link>
          .
        </p>
      </div>

      {cta && <ClosingCtaBand cta={cta} />}
    </main>
  );
}
