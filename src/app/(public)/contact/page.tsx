import Link from "next/link";
import type { Metadata } from "next";
import { REPLY_PROMISE, SUPPORT_EMAIL, whatsappChatHref } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Kontakt",
  description: "Kontaktoni ekipin e Librum.",
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
        <Link href="/help/reading" className="text-primary underline">
          si ta lexoni librin tuaj
        </Link>
        .
      </p>
    </main>
  );
}
