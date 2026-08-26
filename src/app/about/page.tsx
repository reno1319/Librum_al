import Link from "next/link";
import { PageHeader } from "@/components/ui/page-header";
import { SurfaceCard } from "@/components/ui/surface-card";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About",
  description: "Librum is a self-publishing platform for digital ebooks, built for Albanian-language authors.",
};

// LIBRUM 2.0 UI-1: the representative page for the design-system
// foundation -- proves PageHeader, the new --container-content token,
// the warm PAPER/INK palette, and standard section rhythm compose
// correctly on a real page before any other page is touched. Copy is
// unchanged from the pre-UI-1 version; only structure/presentation
// changed. SurfaceCard is used only for the "Questions?" block below,
// which is genuinely card-shaped (a short, distinct call-to-action) --
// the surrounding prose stays plain flowing text, deliberately not
// boxed, to keep the page reading as editorial copy rather than a
// stack of dashboard-style panels.

export default function AboutPage() {
  return (
    <main className="mx-auto w-full max-w-content flex-1 px-4 py-10 sm:px-6">
      <PageHeader title="About Librum" />

      <div className="mt-8 flex flex-col gap-4 text-foreground/90">
        <p>
          Librum is a self-publishing platform for digital ebooks. Authors
          upload their work, set their own price, and publish directly to
          readers — no gatekeepers, no submission queue, no waiting for
          approval.
        </p>

        <p>
          We handle the parts that are genuinely hard to do well: secure file
          storage, payment processing, and getting authors paid. Everything
          else — what to write, how to price it, when to publish — stays in
          the author&apos;s hands.
        </p>
      </div>

      <section className="mt-12">
        <h2 className="font-serif text-xl font-semibold">How the money works</h2>
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
      </section>

      <section className="mt-12">
        <SurfaceCard className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-serif text-lg font-semibold">Questions?</h2>
            <p className="mt-1 text-sm text-foreground/90">
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
          </div>
        </SurfaceCard>
      </section>
    </main>
  );
}
