import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { unfollowAuthor } from "@/app/authors/[id]/actions";
import type { Profile } from "@/lib/types";

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
      <h1 className="font-serif text-3xl font-semibold">
        Authors you follow
      </h1>
      <p className="mt-1 text-sm text-muted">
        You&apos;ll get an email whenever one of them publishes a new book.
      </p>

      {orderedAuthors.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          You&apos;re not following any authors yet.
        </p>
      ) : (
        <ul
          className="mt-8"
          style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
        >
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
                  className="font-serif font-medium hover:underline"
                  style={{ flex: "1 1 auto" }}
                >
                  {author.display_name}
                </Link>
                <form action={unfollowAuthor.bind(null, author.id)}>
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                  >
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
