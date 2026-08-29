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

  const { data: book } = await supabase
    .from("books")
    .select("title")
    .eq("id", id)
    .single();

  if (!book) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href={`/books/${id}`} className="text-sm text-muted hover:underline">
        &larr; Back to book
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">
        Report this book
      </h1>
      <p className="mt-1 text-sm text-muted">
        Reporting &ldquo;{book.title}&rdquo;
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
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
            className="rounded-lg border border-border bg-surface px-3 py-2"
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
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <button
          type="submit"
          className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Submit report
        </button>
      </form>
    </main>
  );
}
