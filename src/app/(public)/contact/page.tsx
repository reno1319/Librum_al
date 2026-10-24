import Link from "next/link";
import type { Metadata } from "next";
import { REPLY_PROMISE, SUPPORT_EMAIL, whatsappChatHref } from "@/lib/contact";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the Librum team.",
};

// TRUST PACK (pipeline item 5): the reply promise (5. a) and the
// WhatsApp link, which renders only while src/lib/contact.ts holds a
// valid number (6. a). The Privacy page's WhatsApp line reads the same
// value, so the two always appear together.
export default function ContactPage() {
  const whatsappHref = whatsappChatHref();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <h1 className="font-serif text-4xl font-normal">Contact</h1>

      <p className="mt-6 text-foreground/90">
        Questions, problems, or feedback — reach out and we&apos;ll get
        back to you. {REPLY_PROMISE}
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
            Chat on WhatsApp
          </a>
        </p>
      )}

      <p className="mt-8 text-sm text-muted">
        Trouble opening a book? See{" "}
        <Link href="/help/reading" className="text-primary underline">
          how to read your book
        </Link>
        .
      </p>
    </main>
  );
}
