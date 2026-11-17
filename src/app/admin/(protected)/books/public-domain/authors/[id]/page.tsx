import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { Alert } from "@/components/ui/alert";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { classicAuthorPath } from "@/lib/classic-authors";
import { ClassicAuthorForm, type ClassicAuthorRow } from "../classic-author-form";

export const metadata: Metadata = {
  title: "Edit classic author",
};

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// K6 (Q1 a): edit one classic author. Same gate and reads as the list.
export default async function EditClassicAuthorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  await requireStaff("books.review");
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);

  const admin = createAdminClient();
  const { data: author, error: readError } = await admin
    .from("classic_authors")
    .select("id, slug, name, birth_year, death_year, birth_place, death_place, bio")
    .eq("id", id)
    .maybeSingle<ClassicAuthorRow>();
  if (!readError && !author) notFound();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <Link
        href="/admin/books/public-domain/authors"
        className="focus-ring inline-flex min-h-11 items-center self-start rounded-sm text-sm text-primary underline underline-offset-2 hover:decoration-2"
      >
        &larr; Classic authors
      </Link>
      {error && <Alert variant="error">{error}</Alert>}
      {success && <Alert variant="success">{success}</Alert>}
      {readError || !author ? (
        <p className="text-sm text-red-700">Couldn’t load this classic author. Please try again.</p>
      ) : (
        <>
          <div>
            <h1 className="font-serif text-[2rem] font-bold text-primary">{author.name}</h1>
            <p className="mt-1 text-sm text-muted">
              Public page (once a work is live):{" "}
              <Link
                href={classicAuthorPath(author.slug)}
                className="focus-ring rounded-sm text-primary underline underline-offset-2"
              >
                {classicAuthorPath(author.slug)}
              </Link>
            </p>
          </div>
          <ClassicAuthorForm author={author} />
        </>
      )}
    </main>
  );
}
