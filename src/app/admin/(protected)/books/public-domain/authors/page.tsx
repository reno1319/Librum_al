import Link from "next/link";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { Alert } from "@/components/ui/alert";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { classicAuthorPath } from "@/lib/classic-authors";
import { ClassicAuthorForm, type ClassicAuthorRow } from "./classic-author-form";

export const metadata: Metadata = {
  title: "Classic authors",
};

// Reads the authors on every request (an add or an edit changes them).
export const dynamic = "force-dynamic";

// K6 (Q1 a): every classic author, with the add form. books.review
// (owner and admin) is the gate, as for linking works; reads use the
// service-role client (classic_authors is service_role only). A page is
// public only while one of the author's works has a live edition.

export default async function ClassicAuthorsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  await requireStaff("books.review");
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);

  const admin = createAdminClient();
  const [authorsResult, worksResult] = await Promise.all([
    admin
      .from("classic_authors")
      .select("id, slug, name, birth_year, death_year, birth_place, death_place, bio")
      .order("name", { ascending: true })
      .limit(500)
      .returns<ClassicAuthorRow[]>(),
    admin
      .from("pd_works")
      .select("classic_author_id")
      .not("classic_author_id", "is", null)
      .limit(2000)
      .returns<{ classic_author_id: string }[]>(),
  ]);
  const failed = Boolean(authorsResult.error || worksResult.error);
  const authors = authorsResult.data ?? [];
  const workCounts = new Map<string, number>();
  for (const work of worksResult.data ?? []) {
    workCounts.set(work.classic_author_id, (workCounts.get(work.classic_author_id) ?? 0) + 1);
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <Link
        href="/admin/books/public-domain"
        className="focus-ring inline-flex min-h-11 items-center self-start rounded-sm text-sm text-primary underline underline-offset-2 hover:decoration-2"
      >
        &larr; Public-domain works
      </Link>
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">Catalog</p>
        <h1 className="mt-1 font-serif text-[2rem] font-bold text-primary md:text-[2.5rem]">Classic authors</h1>
        <p className="mt-1 text-sm text-muted">
          Each classic author gets a page with their years, places and bio. Link their works on Public-domain works.
          The page goes public once one of those works has a live edition.
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}

      {failed ? (
        <p className="text-sm text-red-700">Couldn’t load the classic authors. Please try again.</p>
      ) : authors.length === 0 ? (
        <p className="text-sm text-muted">No classic authors yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
          {authors.map((author) => {
            const works = workCounts.get(author.id) ?? 0;
            return (
              <li key={author.id} className="flex flex-col gap-1 px-4 py-4 sm:px-5">
                <p className="font-serif text-lg text-foreground">
                  <Link
                    href={`/admin/books/public-domain/authors/${author.id}`}
                    className="focus-ring rounded-sm text-primary underline underline-offset-2"
                  >
                    {author.name}
                  </Link>{" "}
                  <span className="text-muted">
                    ({author.birth_year}–{author.death_year})
                  </span>
                </p>
                <p className="text-sm text-muted">
                  {classicAuthorPath(author.slug)} · {works} {works === 1 ? "work" : "works"} linked
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <section className="flex flex-col gap-3 rounded-card border border-border bg-surface px-4 py-5 sm:px-5">
        <h2 className="font-serif text-xl text-foreground">Add a classic author</h2>
        <ClassicAuthorForm author={null} />
      </section>
    </main>
  );
}
