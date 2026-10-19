import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UploadWizard } from "./upload-wizard";
import { Alert } from "@/components/ui/alert";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { getCatalogSchemaFeatures } from "@/lib/catalog-schema-features";
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

  const [{ data: series }, { data: profile }, schemaFeatures, { data: penNames }] = await Promise.all([
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
    // LIBRUM 2.0 PUBLISHING-UX-1 PART C / PR-G: this read used to also
    // fetch stripe_payouts_enabled, to feed the Review step's readiness
    // section. That column is gone from this select: paid publishing is
    // now decided by canPublishPaidTitle() (below), which is a server
    // capability and not an author-specific database column, so this page
    // is back to reading nothing but the author's names.
    supabase
      .from("profiles")
      .select("display_name, public_author_name")
      .eq("id", user.id)
      .single(),
    // F4 (D1): whether the Pen name field and the Rights choice can be
    // shown yet (rendering only; see catalog-schema-features.ts).
    getCatalogSchemaFeatures(),
    // PEN-NAMES-1 (10a): the author's own pen names (RLS: own rows; the
    // author_id filter also keeps a staff account to its own) for the
    // box's suggestions.
    supabase
      .from("pen_names")
      .select("name, is_default")
      .eq("author_id", user.id)
      .order("created_at")
      .returns<{ name: string; is_default: boolean }[]>(),
  ]);

  return (
    // REDESIGN STEP 5 (A2): a wider page so the Price step's side panel
    // fits beside the form; the title row keeps its existing words in the
    // dashboard's heading style, and its text link is underlined at rest.
    <main className="page-container flex-1 pt-5 pb-16 sm:pt-8">
      <Link
        href="/dashboard"
        className="focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
      >
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-4 font-serif text-[1.875rem] font-normal leading-tight text-primary sm:text-[2.5rem]">
        Add a book
      </h1>
      {/* FIX1 (X7): Renato's W-A wording. The sentence it replaces said
          a draft was kept from the start; nothing is saved until a
          final button is pressed (no autosave, his D2). */}
      <p className="mt-2 text-muted">
        Nothing is saved until you press Save as draft or Publish book.
      </p>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      {/* paidPublishingAvailable is display-only context for the Price
          step's readiness section, never a pre-submit gate: Publish book
          can still be pressed regardless, since performPublish()
          (actions.ts) remains the one real server-side enforcement point.
          It is evaluated HERE rather than inside the wizard because the
          wizard is a client component and @/lib/paid-readiness is
          server-only. */}
      <UploadWizard
        series={series ?? []}
        authorName={resolvePublicAuthorName(profile) ?? ""}
        authorId={user.id}
        paidPublishingAvailable={canPublishPaidTitle()}
        penNameAvailable={schemaFeatures.penName}
        penNameSuggestions={(penNames ?? []).filter((p) => !p.is_default).map((p) => p.name)}
        rightsAvailable={schemaFeatures.rights}
      />
    </main>
  );
}
