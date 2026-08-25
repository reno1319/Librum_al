import Link from "next/link";

export default function AboutPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">About Librum</h1>

      <p className="mt-6 text-foreground/90">
        Librum is a self-publishing platform for digital ebooks. Authors
        upload their work, set their own price, and publish directly to
        readers — no gatekeepers, no submission queue, no waiting for
        approval.
      </p>

      <p className="mt-4 text-foreground/90">
        We handle the parts that are genuinely hard to do well: secure file
        storage, payment processing, and getting authors paid. Everything
        else — what to write, how to price it, when to publish — stays in
        the author&apos;s hands.
      </p>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        How the money works
      </h2>
      <p className="mt-3 text-foreground/90">
        Librum takes a 20% platform fee on every sale. The remaining 80%
        is transferred to the author&apos;s bank account by Stripe,
        automatically per sale — actual timing depends on Stripe&apos;s own
        processing schedule. We never see or store payment card details.
        See{" "}
        <Link href="/how-it-works" className="text-primary underline">
          how self-publishing works
        </Link>{" "}
        for the full walkthrough.
      </p>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        Questions?
      </h2>
      <p className="mt-3 text-foreground/90">
        Check the{" "}
        <Link href="/help" className="text-primary underline">
          help page
        </Link>{" "}
        first, or{" "}
        <Link href="/contact" className="text-primary underline">
          get in touch
        </Link>
        .
      </p>
    </main>
  );
}
