import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { UploadWizard } from "./upload-wizard";
import { Alert } from "@/components/ui/alert";
import type { Series } from "@/lib/types";

export default async function NewBookPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/books/new");
  }

  const { data: series } = await supabase
    .from("series")
    .select("*")
    .eq("author_id", user.id)
    .order("title")
    .returns<Series[]>();

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Add a book</h1>
      <p className="mt-1 text-sm text-muted">
        It&apos;s saved as a draft first — you can publish it from your
        dashboard once you&apos;re happy with it.
      </p>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      <UploadWizard series={series ?? []} />
    </main>
  );
}
