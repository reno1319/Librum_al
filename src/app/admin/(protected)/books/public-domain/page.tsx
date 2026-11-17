import Link from "next/link";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { Alert } from "@/components/ui/alert";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { setPdWorkClassicAuthorAsStaff } from "./actions";

export const metadata: Metadata = {
  title: "Public-domain works",
};

// Reads the works on every request (a pick or a swap changes them).
export const dynamic = "force-dynamic";

// BD15 P7 (PLAN-BD15-r1 §2.6, "Vepra të domenit publik"): every
// public-domain work, its one picked edition, and how many uploads are
// linked to it. Staff pick and swap on each book's own page (approving
// a linked book picks it). requireStaff("reports.view") is the gate, as
// for /admin/books; reads use the service-role client (pd_works is
// service_role only, and drafts are linked too).

type WorkRow = {
  id: string;
  title: string;
  original_author: string;
  picked_book_id: string | null;
  classic_author_id: string | null;
};
type ClassicOption = { id: string; name: string; birth_year: number; death_year: number };
type EditionRow = { id: string; title: string; status: string; pd_work_id: string | null };

export default async function PublicDomainWorksPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const staff = await requireStaff("reports.view");
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);
  // K6 (Q1 a): only books.review (owner, admin) links classic authors.
  const canLinkClassics = roleHasPermission(staff.role, "books.review");

  const admin = createAdminClient();
  const [worksResult, editionsResult, classicsResult] = await Promise.all([
    admin
      .from("pd_works")
      .select("id, title, original_author, picked_book_id, classic_author_id")
      .order("title", { ascending: true })
      .limit(500)
      .returns<WorkRow[]>(),
    admin
      .from("books")
      .select("id, title, status, pd_work_id")
      .not("pd_work_id", "is", null)
      .limit(2000)
      .returns<EditionRow[]>(),
    admin
      .from("classic_authors")
      .select("id, name, birth_year, death_year")
      .order("name", { ascending: true })
      .limit(500)
      .returns<ClassicOption[]>(),
  ]);
  const classics = classicsResult.data ?? [];
  const classicById = new Map(classics.map((classic) => [classic.id, classic]));
  const failed = Boolean(worksResult.error || editionsResult.error);
  const works = worksResult.data ?? [];
  const editions = editionsResult.data ?? [];
  const editionsByWork = new Map<string, EditionRow[]>();
  for (const edition of editions) {
    if (!edition.pd_work_id) continue;
    editionsByWork.set(edition.pd_work_id, [...(editionsByWork.get(edition.pd_work_id) ?? []), edition]);
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <Link
        href="/admin/books"
        className="focus-ring inline-flex min-h-11 items-center self-start rounded-sm text-sm text-primary underline underline-offset-2 hover:decoration-2"
      >
        &larr; All books
      </Link>
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">Catalog</p>
        <h1 className="mt-1 font-serif text-[2rem] font-bold text-primary md:text-[2.5rem]">Public-domain works</h1>
        <p className="mt-1 text-sm text-muted">
          Each work has one public edition. You link an upload to a work on its book page, and approving it picks
          it. The previous edition then goes back to its uploader as a draft.
        </p>
        <Link
          href="/admin/books/public-domain/authors"
          className="focus-ring mt-2 inline-flex min-h-11 items-center rounded-sm text-sm text-primary underline underline-offset-2 hover:decoration-2"
        >
          Classic authors &rarr;
        </Link>
      </div>

      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}

      {failed ? (
        <p className="text-sm text-red-700">Couldn’t load the public-domain works. Please try again.</p>
      ) : works.length === 0 ? (
        <p className="text-sm text-muted">No public-domain works yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-card border border-border bg-surface">
          {works.map((work) => {
            const linked = editionsByWork.get(work.id) ?? [];
            const picked = linked.find((edition) => edition.id === work.picked_book_id) ?? null;
            return (
              <li key={work.id} className="flex flex-col gap-1 px-4 py-4 sm:px-5">
                <p className="font-serif text-lg text-foreground">{work.title}</p>
                <p className="text-sm text-muted">{work.original_author}</p>
                <p className="text-sm">
                  {picked ? (
                    <>
                      Picked edition:{" "}
                      <Link
                        href={`/admin/books/${picked.id}`}
                        className="focus-ring rounded-sm text-primary underline underline-offset-2"
                      >
                        {picked.title}
                      </Link>
                      {picked.status === "published" ? " (live)" : " (not live)"}
                    </>
                  ) : (
                    "No picked edition."
                  )}
                  {` · ${linked.length} ${linked.length === 1 ? "upload" : "uploads"} linked`}
                </p>
                {canLinkClassics && !classicsResult.error ? (
                  <form action={setPdWorkClassicAuthorAsStaff} className="mt-1 flex flex-wrap items-end gap-2">
                    <input type="hidden" name="workId" value={work.id} />
                    <label className="flex flex-col gap-1 text-sm">
                      Classic author
                      <select
                        name="classicAuthorId"
                        defaultValue={work.classic_author_id ?? ""}
                        className="focus-ring min-h-11 rounded-md border border-border bg-surface px-3 text-[0.9375rem]"
                      >
                        <option value="">None (the name links to a search)</option>
                        {classics.map((classic) => (
                          <option key={classic.id} value={classic.id}>
                            {classic.name} ({classic.birth_year}–{classic.death_year})
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="focus-ring inline-flex min-h-11 items-center justify-center rounded-full border border-primary bg-surface px-[1.125rem] text-sm font-semibold text-primary hover:bg-surface-hover"
                    >
                      Save
                    </button>
                  </form>
                ) : (
                  <p className="text-sm text-muted">
                    Classic author:{" "}
                    {work.classic_author_id ? (classicById.get(work.classic_author_id)?.name ?? "linked") : "none"}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
