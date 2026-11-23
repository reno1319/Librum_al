import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createPenName } from "../pen-names/actions";
import { FROM_AUTHORS_FIELD, FROM_AUTHORS_VALUE, PenNameCard } from "../profile/pen-name-card";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { PEN_NAME_MAX_LENGTH, type OwnPenName } from "@/lib/pen-names";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Autorët",
};

// BUILD 2a-2 (approved picture 7): a publishing house's Autorët tab. Its
// authors are its non-default pen names (build 1's machinery: the same
// cards, createPenName, updatePenName and deletePenName); the house's own
// name is its default pen name, edited on Profili. A person author has
// no Autorët tab: this address sends them to Profili.
export default async function HouseAuthorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/authors");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("account_kind")
    .eq("id", user.id)
    .single<{ account_kind?: string | null }>();
  if (profile?.account_kind !== "publishing_house") {
    redirect("/dashboard/profile");
  }

  const [{ data: penNames }, { data: books }, { data: series }, { data: bundles }] = await Promise.all([
    supabase
      .from("pen_names")
      .select("id, name, bio, avatar_path, links, is_default, created_at")
      .eq("author_id", user.id)
      .eq("is_default", false)
      .order("created_at")
      .returns<OwnPenName[]>(),
    supabase.from("books").select("pen_name_id").eq("author_id", user.id).returns<{ pen_name_id: string }[]>(),
    supabase.from("series").select("pen_name_id").eq("author_id", user.id).returns<{ pen_name_id: string }[]>(),
    supabase.from("bundles").select("pen_name_id").eq("author_id", user.id).returns<{ pen_name_id: string }[]>(),
  ]);

  const bookCount = new Map<string, number>();
  for (const b of books ?? []) bookCount.set(b.pen_name_id, (bookCount.get(b.pen_name_id) ?? 0) + 1);
  const usedBySeriesOrBundle = new Set([...(series ?? []), ...(bundles ?? [])].map((r) => r.pen_name_id));

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Autorët"
          description="Shtoni sa autorë të doni. Çdo autor ka faqen e vet me librat e tij. Lexuesit shohin biografinë, foton ose lidhjet vetëm nëse i shtoni."
        />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {/* Same name box as "+ Shto pseudonim": nothing is saved until a
          name is typed. <details> works without JavaScript. */}
      <details className="group mt-4">
        <summary className={buttonClasses("primary", "md", "inline-flex cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
          + Shto autor
        </summary>
        <form action={createPenName} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name={FROM_AUTHORS_FIELD} value={FROM_AUTHORS_VALUE} />
          <label className="flex flex-1 flex-col gap-1 text-sm">
            Emri i autorit
            <input name="name" type="text" required maxLength={PEN_NAME_MAX_LENGTH} className={formControlClasses} />
          </label>
          <button type="submit" className={buttonClasses("primary", "md", "self-start sm:self-auto")}>
            Shto
          </button>
        </form>
      </details>

      {(penNames ?? []).length > 0 && (
        <ul className="mt-6 flex flex-col gap-6">
          {(penNames ?? []).map((penName) => {
            const count = bookCount.get(penName.id) ?? 0;
            const photoUrl = penName.avatar_path
              ? supabase.storage.from("avatars").getPublicUrl(penName.avatar_path).data.publicUrl
              : null;
            return (
              <li key={penName.id}>
                <PenNameCard
                  kind="houseAuthor"
                  penName={penName}
                  userId={user.id}
                  photoUrl={photoUrl}
                  bookCount={count}
                  used={count > 0 || usedBySeriesOrBundle.has(penName.id)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
