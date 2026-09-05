import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { AvatarField } from "@/components/avatar-field";
import { formControlClasses } from "@/lib/form-styles";
import { resolvePublicAuthorName } from "@/lib/author-name";
import type { Profile } from "@/lib/types";
import type { Metadata } from "next";

// LIBRUM 2.0 AUTHOR-1A
const PUBLIC_AUTHOR_NAME_MAX_LENGTH = 120;

export const metadata: Metadata = {
  title: "Author profile",
};

export default async function EditProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/profile");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single<Profile>();

  const avatarUrl = profile?.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(profile.avatar_path).data
        .publicUrl
    : null;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader title="Edit your profile" description="Manage your account and, if you're an author, how you're credited to readers." />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          Profile updated.
        </Alert>
      )}

      <form action={updateProfile} className="mt-6 flex flex-col gap-4">
        <AvatarField userId={user.id} existingAvatarUrl={avatarUrl} />

        <label className="flex flex-col gap-1 text-sm">
          Account name
          <input
            name="displayName"
            type="text"
            required
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
          <span className="text-xs text-muted">
            Your account name. Not shown to readers as your author name once you set a public author name below.
          </span>
        </label>

        {/* LIBRUM 2.0 AUTHOR-1A: reader-role profiles have no public
            attribution surface at all (no public reader-profile page
            exists) -- showing this field to them would be dead UI with
            nothing to explain it. Gated on the server-derived role, same
            source of truth updateProfile() itself uses. */}
        {profile?.role === "author" && (
          <label className="flex flex-col gap-1 text-sm">
            Public author name
            <input
              name="publicAuthorName"
              type="text"
              required
              maxLength={PUBLIC_AUTHOR_NAME_MAX_LENGTH}
              defaultValue={resolvePublicAuthorName(profile) ?? ""}
              className={formControlClasses}
            />
            <span className="text-xs text-muted">
              This is the name readers will see on your books and author page.
            </span>
            <span className="text-xs text-muted">
              If you publish under a pen name, set it before publishing. The author name may be
              embedded in your EPUB file.
            </span>
          </label>
        )}

        <label className="flex flex-col gap-1 text-sm">
          Bio
          <textarea
            name="bio"
            rows={4}
            defaultValue={profile?.bio ?? ""}
            placeholder="A few sentences about you and what you write."
            className={formControlClasses}
          />
        </label>

        <button type="submit" className={buttonClasses("primary", "md", "mt-2")}>
          Save
        </button>
      </form>
    </main>
  );
}
