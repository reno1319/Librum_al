import Link from "next/link";
import type { Metadata } from "next";
import { canonicalMetadata } from "@/lib/seo";
import { REPLY_PROMISE, SUPPORT_EMAIL, whatsappChatHref } from "@/lib/contact";

export const metadata: Metadata = {
  // M2 (Renato 11-27, fx5 a): the bare address as canonical link.
  ...canonicalMetadata("/kontakt"),
  title: "Kontakt",
  // P7 (Renato 11-27): one fuller sentence for search results.
  description: "Na shkruani për pyetje rreth botimit, blerjeve, leximit të librave ose llogarisë suaj në Librum.",
};

// TRUST PACK (pipeline item 5): the reply promise (5. a) and the
// WhatsApp link, which renders only while src/lib/contact.ts holds a
// valid number (6. a). The Privacy page's WhatsApp line reads the same
// value, so the two always appear together.
export default function ContactPage() {
  const whatsappHref = whatsappChatHref();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <h1 className="font-serif text-4xl font-normal">Kontakt</h1>

      <p className="mt-6 text-foreground/90">
        Pyetje, probleme apo mendime? Na shkruani dhe do t&apos;ju
        përgjigjemi. {REPLY_PROMISE}
      </p>

      <p className="mt-4">
        <a
          href={`mailto:${SUPPORT_EMAIL}`}
          className="text-lg font-medium text-primary underline"
        >
          {SUPPORT_EMAIL}
        </a>
      </p>

      {whatsappHref && (
        <p className="mt-3">
          <a
            href={whatsappHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-lg font-medium text-primary underline"
          >
            Na shkruani në WhatsApp
            <span className="sr-only"> (hapet në një skedë të re)</span>
          </a>
        </p>
      )}

      <p className="mt-8 text-sm text-muted">
        Nuk arrini ta hapni një libër? Shihni{" "}
        <Link href="/ndihme/leximi" className="text-primary underline">
          si ta lexoni librin tuaj
        </Link>
        .
      </p>
    </main>
  );
}
