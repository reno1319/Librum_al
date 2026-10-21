import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { unfollowPenName } from "@/app/(public)/authors/[id]/actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { authorPagePath, type PublicPenName } from "@/lib/pen-names";
import type { Metadata } from "next";

// PEN-NAMES-1 (migration 20261019184512, 4a): readers follow pen names.
// The list reads the caller's own pen_name_follows rows (RLS: own rows
// only), then the pen names through the public_pen_names view -- no
// account columns. A followed pen name with no public book, series or
// bundle (not in the view) is left out.
type FollowedPenName = Pick<PublicPenName, "id" | "name" | "avatar_path">;

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
    .from("pen_name_follows")
    .select("pen_name_id")
    .eq("follower_id", user.id)
    .order("created_at", { ascending: false });

  const penNameIds = (follows ?? []).map((f) => f.pen_name_id as string);

  const { data: authors } =
    penNameIds.length > 0
      ? await supabase
          .from("public_pen_names")
          .select("id, name, avatar_path")
          .in("id", penNameIds)
          .returns<FollowedPenName[]>()
      : { data: [] as FollowedPenName[] };

  // Re-order to match the follow list (most recently followed first) —
  // the .in() query above doesn't preserve that order on its own.
  const byId = new Map((authors ?? []).map((a) => [a.id, a]));
  const orderedAuthors = penNameIds
    .map((id) => byId.get(id))
    .filter((a): a is FollowedPenName => !!a);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
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
                className="flex flex-wrap items-center gap-4 rounded-card border border-border bg-surface p-4 shadow-sm"
              >
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt=""
                    className="size-12 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="size-12 shrink-0 rounded-full bg-border" />
                )}
                <Link
                  href={authorPagePath(author.id)}
                  className="focus-ring flex-1 rounded-sm font-serif font-medium hover:underline"
                >
                  {author.name}
                </Link>
                <form action={unfollowPenName.bind(null, author.id)}>
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
