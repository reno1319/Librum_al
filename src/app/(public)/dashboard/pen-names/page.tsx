import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { deletePenName, updatePenName } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { AvatarField } from "@/components/avatar-field";
import { formControlClasses } from "@/lib/form-styles";
import {
  PEN_NAME_BIO_MAX_LENGTH,
  PEN_NAME_LINK_MAX_LENGTH,
  PEN_NAME_MAX_LENGTH,
  PEN_NAME_MAX_LINKS,
  authorPagePath,
  readPenNameLinks,
  type OwnPenName,
} from "@/lib/pen-names";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Pen names",
};

// PEN-NAMES-1 (migration 20261019184512): Dashboard > Pen names. Each pen
// name has its own Author Page (1a) with its own bio, photo and links
// (2a, 8a), shown to readers only when filled in (7a). The default pen
// name is the Profile's Public author name. A new pen name is created
// from the pen name box under a book's Title (10a); one no book, series
// or bundle uses can be deleted here.
//
// Look: the A2 mockup has no pen names screen, so this follows Dashboard
// > Profile (same width, header, alerts, form controls).
export default async function PenNamesPage({
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
    redirect("/login?next=/dashboard/pen-names");
  }

  const [{ data: penNames }, { data: books }, { data: series }, { data: bundles }] = await Promise.all([
    supabase
      .from("pen_names")
      .select("id, name, bio, avatar_path, links, is_default, created_at")
      .eq("author_id", user.id)
      .order("is_default", { ascending: false })
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
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Pen names"
          description="Each pen name has its own author page with its books. Readers see a bio, photo or links only if you add them."
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

      <p className="mt-4 text-sm text-muted">
        To add a pen name, type a new name in the Pen name box under a book&apos;s title.
      </p>

      {(penNames ?? []).length === 0 ? (
        <EmptyState className="mt-6" description="No pen names yet." />
      ) : (
        <ul className="mt-6 flex flex-col gap-6">
          {(penNames ?? []).map((penName) => {
            const links = readPenNameLinks(penName.links);
            const count = bookCount.get(penName.id) ?? 0;
            const used = count > 0 || usedBySeriesOrBundle.has(penName.id);
            const photoUrl = penName.avatar_path
              ? supabase.storage.from("avatars").getPublicUrl(penName.avatar_path).data.publicUrl
              : null;

            return (
              <li key={penName.id} className="rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="min-w-0 break-words font-serif text-xl font-normal text-primary">{penName.name}</h2>
                  <p className="text-xs text-muted">
                    {penName.is_default ? "Default · " : ""}
                    {count} {count === 1 ? "book" : "books"}
                  </p>
                </div>
                {penName.is_default && (
                  <p className="mt-1 text-sm text-muted">
                    Your Public author name, used for books without another pen name.
                  </p>
                )}
                {used && (
                  <Link
                    href={authorPagePath(penName.id)}
                    className="focus-ring mt-1 inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
                  >
                    View author page &rarr;
                  </Link>
                )}

                <form action={updatePenName.bind(null, penName.id)} className="mt-4 flex flex-col gap-4">
                  <AvatarField userId={user.id} existingAvatarUrl={photoUrl} />
                  {photoUrl && (
                    <label className="flex items-center gap-2 text-sm">
                      <input type="checkbox" name="removePhoto" className="focus-ring size-4" />
                      Remove photo
                    </label>
                  )}

                  <label className="flex flex-col gap-1 text-sm">
                    Name
                    <input
                      name="name"
                      type="text"
                      required
                      maxLength={PEN_NAME_MAX_LENGTH}
                      defaultValue={penName.name}
                      className={formControlClasses}
                    />
                  </label>

                  <label className="flex flex-col gap-1 text-sm">
                    Bio (optional)
                    <textarea
                      name="bio"
                      rows={4}
                      maxLength={PEN_NAME_BIO_MAX_LENGTH}
                      defaultValue={penName.bio ?? ""}
                      placeholder="A few sentences readers see on this pen name's author page."
                      className={formControlClasses}
                    />
                  </label>

                  <fieldset className="flex flex-col gap-2 text-sm">
                    <legend className="mb-1">Links (optional, up to {PEN_NAME_MAX_LINKS})</legend>
                    {Array.from({ length: PEN_NAME_MAX_LINKS }, (_, i) => (
                      <input
                        key={i}
                        name="links"
                        type="url"
                        inputMode="url"
                        maxLength={PEN_NAME_LINK_MAX_LENGTH}
                        pattern="https://.*"
                        placeholder="https://"
                        aria-label={`Link ${i + 1}`}
                        defaultValue={links[i] ?? ""}
                        className={formControlClasses}
                      />
                    ))}
                    <span className="text-muted">Full web addresses starting with https://.</span>
                  </fieldset>

                  <div className="flex flex-wrap items-center gap-3">
                    <button type="submit" className={buttonClasses("primary", "md")}>
                      Save
                    </button>
                  </div>
                </form>

                {!penName.is_default && !used && (
                  <form action={deletePenName.bind(null, penName.id)} className="mt-3">
                    <button
                      type="submit"
                      className="focus-ring rounded-control border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                    >
                      Delete pen name
                    </button>
                  </form>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
