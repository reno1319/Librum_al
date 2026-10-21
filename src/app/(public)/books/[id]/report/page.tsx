import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { submitReport } from "../actions";
import { REPORT_REASONS } from "@/lib/report-reasons";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Report a book",
};

export default async function ReportBookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error } = await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/books/${id}/report`);
  }

  // PEN-NAMES-2: public_books, like every public read of a book.
  const { data: book } = await supabase
    .from("public_books")
    .select("title")
    .eq("id", id)
    .single();

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <Link href={`/books/${id}`} className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Back to book
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-normal">
        Report this book
      </h1>
      <p className="mt-1 text-sm text-muted">
        Reporting &ldquo;{book.title}&rdquo;
      </p>

      {error && (
        <p className="mt-4 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form
        action={submitReport.bind(null, id)}
        className="mt-6 flex flex-col gap-4"
      >
        <label className="flex flex-col gap-1 text-sm">
          Reason
          <select
            name="reason"
            required
            defaultValue=""
            className="rounded-control border border-control bg-surface px-3 py-2"
          >
            <option value="" disabled>
              Choose a reason
            </option>
            {REPORT_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Details (optional)
          <textarea
            name="details"
            rows={4}
            className="rounded-control border border-control bg-surface px-3 py-2"
          />
        </label>

        <button
          type="submit"
          className="w-fit rounded-control bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Submit report
        </button>
      </form>
    </main>
  );
}
