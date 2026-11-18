import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/(public)/auth/actions";
import { PageHeader } from "@/components/ui/page-header";
import { SurfaceCard } from "@/components/ui/surface-card";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { pageErrorMessage } from "@/lib/page-messages";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { restoreAccount } from "./actions";

export const metadata: Metadata = {
  title: "Llogaria juaj do të fshihet",
  robots: { index: false },
};

// DEL (del2 b): the only page a signed-in account waiting to be deleted
// can open (Proxy sends every other request here,
// src/lib/supabase/middleware.ts). Nothing changes unless the person
// presses Restore.
export default async function RestoreAccountPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error: rawError } = await searchParams;
  const error = pageErrorMessage(rawError);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: deleteAfter, error: readError } = await supabase.rpc("my_account_deletion_date");
  if (readError) {
    throw new Error("The deletion date could not be read.");
  }
  if (typeof deleteAfter !== "string") {
    // Not waiting to be deleted (restored in another tab, say).
    redirect("/account");
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <PageHeader title="Llogaria juaj do të fshihet" />
      <SurfaceCard className="mt-8">
        {error && (
          <Alert variant="error" className="mb-3">
            {error}
          </Alert>
        )}
        <p className="text-sm text-foreground/90">
          Më <strong>{formatTimestampAsDate(deleteAfter)}</strong> llogaria juaj fshihet përgjithmonë.
        </p>
        <p className="mt-2 text-sm text-foreground/90">
          Deri atëherë mund ta riktheni ashtu siç ishte, me gjithçka që kishte.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <form action={restoreAccount}>
            <button type="submit" className={buttonClasses("primary", "md")}>
              Riktheni llogarinë time
            </button>
          </form>
          <form action={logout}>
            <button type="submit" className={buttonClasses("secondary", "md")}>
              Dilni
            </button>
          </form>
        </div>
      </SurfaceCard>
    </main>
  );
}
