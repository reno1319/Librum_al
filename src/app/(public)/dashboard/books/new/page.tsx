import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UploadWizard } from "./upload-wizard";
import { Alert } from "@/components/ui/alert";
import { resolvePublicAuthorName } from "@/lib/author-name";
import type { Series } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "New book",
};

export default async function NewBookPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/books/new");
  }

  const [{ data: series }, { data: profile }] = await Promise.all([
    supabase.from("series").select("*").eq("author_id", user.id).order("title").returns<Series[]>(),
    // LIBRUM 2.0 PRODUCT-5: display_name is passed through to
    // ManuscriptField so a DOCX-converted EPUB's internal dc:creator
    // metadata uses Librum's authoritative name, never anything
    // inferred from the manuscript itself.
    //
    // LIBRUM 2.0 AUTHOR-1B: public_author_name added alongside
    // display_name -- resolved via resolvePublicAuthorName() below, so
    // the name baked into dc:creator is the same reader-facing identity
    // shown on the book's own page, never the private account name.
    //
    // LIBRUM 2.0 PUBLISHING-UX-1 PART C: stripe_payouts_enabled is the
    // ONE new column this pass reads, mirroring the Edit Book page's own
    // identical read (see its page.tsx) -- display-only context for the
    // Review step's readiness section (resolvePublishReadiness()), never
    // a pre-submit gate: Publish book can still be pressed regardless,
    // since performPublish() (actions.ts) remains the one real
    // server-side enforcement point. Never used to build a pre-submit
    // link to /dashboard/payouts -- that would risk losing unsaved
    // wizard state.
    supabase
      .from("profiles")
      .select("display_name, public_author_name, stripe_payouts_enabled")
      .eq("id", user.id)
      .single(),
  ]);

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Add a book</h1>
      <p className="mt-1 text-sm text-muted">
        It&apos;s saved as a draft first — you can publish it from your
        dashboard once you&apos;re happy with it.
      </p>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      <UploadWizard
        series={series ?? []}
        authorName={resolvePublicAuthorName(profile) ?? ""}
        authorId={user.id}
        payoutsEnabled={!!profile?.stripe_payouts_enabled}
      />
    </main>
  );
}
