import Link from "next/link";
import { PageBand, SECTION_CONTAINER } from "@/components/page-bands";
import { REPLY_PROMISE, SUPPORT_EMAIL } from "@/lib/contact";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How to read your book",
  description: "Where your Librum downloads are, and how to open an EPUB on iPhone, Android, a computer or a Kindle.",
};

// TRUST PACK (pipeline item 5, Renato 10-24): the reader help page
// (1. a: its own page, linked from Help, the Library and the line next
// to Download). 2. a: it names Apple Books, Google Play Books, Thorium
// Reader and Amazon's Send to Kindle, with a link to Amazon's page.
// The cancel paragraph repeats the Refund Policy's 14-day rule and the
// warning DOWNLOADS-1 shows next to Download; it adds no rule of its own.
export const SEND_TO_KINDLE_HREF = "https://www.amazon.com/sendtokindle";
export const THORIUM_HREF = "https://thorium.edrlab.org/";

const DEVICES: { id: string; heading: string; steps: string[] }[] = [
  {
    id: "iphone",
    heading: "iPhone or iPad",
    steps: [
      "Tap Download EPUB. Safari saves the book to the Files app.",
      "Open the Files app and go to Downloads.",
      "Tap the book, tap the Share button, then choose Books.",
      "The book opens in Apple Books and stays in its Library.",
    ],
  },
  {
    id: "android",
    heading: "Android phone or tablet",
    steps: [
      "Tap Download EPUB. The book is saved to your Downloads folder.",
      "Open the Files app (on some phones it's called My Files) and go to Downloads.",
      "Tap the book and choose Google Play Books, or another EPUB reading app.",
      "If no app offers to open it, install Google Play Books from the Play Store and try again.",
    ],
  },
  {
    id: "computer",
    heading: "Computer",
    steps: [
      "Click Download EPUB. The book is saved to your Downloads folder.",
      "On a Mac, double-click the book and it opens in Apple Books.",
      "On Windows, install Thorium Reader (free), then open the book with it.",
    ],
  },
];

const LINK_CLASSES = "text-primary underline";

export default function ReadingHelpPage() {
  return (
    <main className="flex-1">
      <PageBand
        eyebrow="Help"
        title="How to read your book"
        lead="Every Librum book is an EPUB file with no DRM, so it opens in the reading app you already use."
      >
        <nav aria-label="Devices" className="mt-6">
          <ul className="flex flex-wrap gap-2.5">
            {[...DEVICES, { id: "kindle", heading: "Kindle" }].map((device) => (
              <li key={device.id}>
                <a
                  href={`#${device.id}`}
                  className="focus-ring inline-flex min-h-11 items-center rounded-[3px] border border-primary-foreground/40 px-4 text-sm font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover"
                >
                  {device.heading}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </PageBand>

      <div className={SECTION_CONTAINER}>
        <div className="flex max-w-2xl flex-col gap-10 leading-relaxed text-foreground/90">
          <section aria-labelledby="where-heading">
            <h2 id="where-heading" className="font-serif text-2xl font-normal text-primary">
              Where your books are
            </h2>
            <p className="mt-3">
              Every book you get on Librum, free or paid, is in{" "}
              <Link href="/library" className={LINK_CLASSES}>
                your Library
              </Link>
              . Tap Download EPUB under a book to save it to your phone or
              computer. You can download it again whenever you need to, for
              example on a new phone.
            </p>
          </section>

          <section aria-labelledby="cancel-heading">
            <h2 id="cancel-heading" className="font-serif text-2xl font-normal text-primary">
              Before your first download
            </h2>
            <p className="mt-3">
              You can cancel a paid purchase within 14 days, as long as you
              haven&apos;t downloaded the book yet. Your first download ends
              that right. While you can still cancel, you&apos;ll see a
              reminder next to the Download button. Free books have nothing to
              cancel. The{" "}
              <Link href="/refunds" className={LINK_CLASSES}>
                Refund Policy
              </Link>{" "}
              has the details.
            </p>
          </section>

          {DEVICES.map((device) => (
            <section key={device.id} id={device.id} aria-labelledby={`${device.id}-heading`} className="scroll-mt-6">
              <h2 id={`${device.id}-heading`} className="font-serif text-2xl font-normal text-primary">
                {device.heading}
              </h2>
              <ol className="mt-3 list-decimal pl-5">
                {device.steps.map((step) => (
                  <li key={step} className="mt-1.5">
                    {step}
                  </li>
                ))}
              </ol>
              {device.id === "computer" && (
                <p className="mt-3 text-sm text-muted">
                  Thorium Reader:{" "}
                  <a href={THORIUM_HREF} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
                    thorium.edrlab.org
                  </a>
                </p>
              )}
            </section>
          ))}

          <section id="kindle" aria-labelledby="kindle-heading" className="scroll-mt-6">
            <h2 id="kindle-heading" className="font-serif text-2xl font-normal text-primary">
              Kindle
            </h2>
            <p className="mt-3">
              Kindle doesn&apos;t open EPUB files straight from your downloads,
              but Amazon&apos;s free Send to Kindle service takes them. Download
              the book first, then send it from Amazon&apos;s{" "}
              <a href={SEND_TO_KINDLE_HREF} target="_blank" rel="noopener noreferrer" className={LINK_CLASSES}>
                Send to Kindle page
              </a>
              . It then appears on your Kindle and in the Kindle app. Amazon
              converts the file, so the layout can look a little different.
            </p>
          </section>

          <section aria-labelledby="problem-heading">
            <h2 id="problem-heading" className="font-serif text-2xl font-normal text-primary">
              Book won&apos;t download or open?
            </h2>
            <p className="mt-3">
              Email{" "}
              <a href={`mailto:${SUPPORT_EMAIL}`} className={LINK_CLASSES}>
                {SUPPORT_EMAIL}
              </a>{" "}
              and tell us which book and which device. {REPLY_PROMISE}
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
