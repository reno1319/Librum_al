import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the Librum team.",
};

export default function ContactPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <h1 className="font-serif text-4xl font-normal">Contact</h1>

      <p className="mt-6 text-foreground/90">
        Questions, problems, or feedback — reach out and we&apos;ll get
        back to you.
      </p>

      <p className="mt-4">
        <a
          href="mailto:support@librum.al"
          className="text-lg font-medium text-primary underline"
        >
          support@librum.al
        </a>
      </p>
    </main>
  );
}
