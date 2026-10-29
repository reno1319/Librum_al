import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/lib/account-name";
import type { Profile } from "@/lib/types";
import type { Metadata } from "next";
import { pageErrorMessage } from "@/lib/page-messages";

// LIBRUM 2.0 AUTHOR-1A
const PUBLIC_AUTHOR_NAME_MAX_LENGTH = 120;

export const metadata: Metadata = {
  title: "Profili i autorit",
};

export default async function EditProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error: rawError, success } = await searchParams;
  const error = pageErrorMessage(rawError);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/profile");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, public_author_name, role")
    .eq("id", user.id)
    .single<Pick<Profile, "display_name" | "public_author_name" | "role">>();

  // PEN-NAMES-1 r4 (owner decision 18a): no Bio box and no photo here --
  // bio and photo are edited per pen name in Dashboard > Pen names.

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader title="Ndryshoni profilin" description="Menaxhoni llogarinë tuaj dhe, nëse jeni autor, emrin me të cilin ju njohin lexuesit." />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          Profili u përditësua.
        </Alert>
      )}

      <form action={updateProfile} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Emri i llogarisë
          <input
            name="displayName"
            type="text"
            required
            maxLength={ACCOUNT_NAME_MAX_LENGTH}
            defaultValue={profile?.display_name}
            className={formControlClasses}
          />
          {/* LIBRUM 2.0 AUTHOR-1A: display_name is account/private
              identity only, never a claim of legal accuracy -- Librum has
              no legal-name/KYC verification. Kept short and factual,
              deliberately not labeled "Legal name".
              LIBRUM 2.0 AUTHOR-1B: scoped to "as your author name"
              specifically, not a blanket "never shown to readers" claim
              -- after the full attribution sweep, this account name is
              confirmed never used for author attribution (books, author
              page, series, bundles, samples, follower emails, EPUB
              dc:creator) once a public author name is set, via
              resolvePublicAuthorName() everywhere. It can still appear to
              readers in an unrelated context this account takes part in
              as a reader itself -- e.g. next to a book review this same
              account posts -- which is a separate identity concept the
              caption must not imply is covered. */}
          <span className="text-sm text-muted">
            Emri i llogarisë suaj. Nuk u shfaqet lexuesve si emër autori pasi të vendosni më poshtë emrin publik të autorit.
          </span>
        </label>

        {/* LIBRUM 2.0 AUTHOR-1A: reader-role profiles have no public
            attribution surface at all (no public reader-profile page
            exists) -- showing this field to them would be dead UI with
            nothing to explain it. Gated on the server-derived role, same
            source of truth updateProfile() itself uses. */}
        {profile?.role === "author" && (
          <label className="flex flex-col gap-1 text-sm">
            Emri publik i autorit
            <input
              name="publicAuthorName"
              type="text"
              required
              maxLength={PUBLIC_AUTHOR_NAME_MAX_LENGTH}
              defaultValue={resolvePublicAuthorName(profile) ?? ""}
              className={formControlClasses}
            />
            <span className="text-sm text-muted">
              Ky është emri që lexuesit do të shohin te librat tuaj dhe te faqja juaj e autorit.
            </span>
            {/* PEN-NAMES-1: the Public author name is the default pen
                name; each pen name's own bio, photo and links are what
                readers see. */}
            <span className="text-sm text-muted">
              Është edhe pseudonimi juaj kryesor. Biografinë, foton dhe lidhjet që shohin lexuesit për çdo
              pseudonim i vendosni te{" "}
              <Link href="/dashboard/pen-names" className="underline underline-offset-2">
                Pseudonimet
              </Link>
              .
            </span>
            <span className="text-sm text-muted">
              Nëse botoni me pseudonim, vendoseni para publikimit. Emri i autorit mund të
              futet brenda skedarit tuaj EPUB.
            </span>
          </label>
        )}

        <button type="submit" className={buttonClasses("primary", "md", "mt-2")}>
          Ruani
        </button>
      </form>
    </main>
  );
}
