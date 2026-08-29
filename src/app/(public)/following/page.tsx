import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { unfollowAuthor } from "@/app/(public)/authors/[id]/actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import type { Profile } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Following",
  description: "Authors you follow on Librum.",
};

export default async function FollowingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/following");
  }

  const { data: follows } = await supabase
    .from("author_follows")
    .select("author_id")
    .eq("follower_id", user.id)
    .order("created_at", { ascending: false });

  const authorIds = (follows ?? []).map((f) => f.author_id);

  const { data: authors } =
    authorIds.length > 0
      ? await supabase.from("profiles").select("*").in("id", authorIds).returns<Profile[]>()
      : { data: [] as Profile[] };

  // Re-order to match the follow list (most recently followed first) —
  // the .in() query above doesn't preserve that order on its own.
  const byId = new Map((authors ?? []).map((a) => [a.id, a]));
  const orderedAuthors = authorIds
    .map((id) => byId.get(id))
    .filter((a): a is Profile => !!a);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <PageHeader
        title="Authors you follow"
        description="You'll get an email whenever one of them publishes a new book."
      />

      {orderedAuthors.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="You're not following any authors yet."
        />
      ) : (
        <ul className="mt-8 flex flex-col gap-3">
          {orderedAuthors.map((author) => {
            const avatarUrl = author.avatar_path
              ? supabase.storage.from("avatars").getPublicUrl(author.avatar_path)
                  .data.publicUrl
              : null;

            return (
              <li
                key={author.id}
                className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
              >
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt=""
                    className="h-12 w-12 rounded-full object-cover"
                  />
                ) : (
                  <div className="h-12 w-12 rounded-full bg-border" />
                )}
                <Link
                  href={`/authors/${author.id}`}
                  className="focus-ring flex-1 rounded-sm font-serif font-medium hover:underline"
                >
                  {author.display_name}
                </Link>
                <form action={unfollowAuthor.bind(null, author.id)}>
                  <button type="submit" className={buttonClasses("outline", "sm")}>
                    Unfollow
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
