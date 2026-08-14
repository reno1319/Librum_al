import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "./actions";
import type { Profile } from "@/lib/types";

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

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user!.id)
    .single<Profile>();

  const avatarUrl = profile?.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(profile.avatar_path).data
        .publicUrl
    : null;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">
        Edit your profile
      </h1>
      <p className="mt-1 text-sm text-muted">
        This is what readers see on your public author page.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          Profile updated.
        </p>
      )}

      <form action={updateProfile} className="mt-6 flex flex-col gap-4">
        <div className="flex items-center gap-4">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              alt=""
              className="h-16 w-16 rounded-full object-cover"
            />
          ) : (
            <div className="h-16 w-16 rounded-full bg-border" />
          )}
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Photo (JPG or PNG, up to 5MB)
            <input
              name="avatar"
              type="file"
              accept="image/png,image/jpeg"
              className="text-sm"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            name="displayName"
            type="text"
            required
            defaultValue={profile?.display_name}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Bio
          <textarea
            name="bio"
            rows={4}
            defaultValue={profile?.bio ?? ""}
            placeholder="A few sentences about you and what you write."
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <button
          type="submit"
          className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Save
        </button>
      </form>
    </main>
  );
}
