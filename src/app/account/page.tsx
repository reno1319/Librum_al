import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";
import { deleteAccount } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { SurfaceCard } from "@/components/ui/surface-card";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Account",
  description: "Manage your Librum account.",
};

// LIBRUM 2.0 UI-9: Account is identity / security-adjacent actions /
// transaction history -- current ownership and download access stay on
// Library (see src/app/library/page.tsx). "Security-adjacent" is
// deliberately narrow today: there is no authenticated password-change
// or email-change flow to surface here (see AUTH-1, carried forward,
// and the UI-9 audit's own finding that no such flow exists) -- so this
// page has no empty "Security" section, only the sections that have a
// real action behind them.
export default async function AccountPage({
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
    redirect("/login?next=/account");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name, role")
    .eq("id", user.id)
    .single();

  const isAuthor = profile?.role === "author";
  const roleLabel = isAuthor ? "Author" : profile?.role === "reader" ? "Reader" : null;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-4 py-10 sm:px-6">
      <PageHeader
        title="Account"
        description="Manage your Librum account and access your account history."
      />

      <SurfaceCard className="mt-8">
        <h2 className="font-serif text-lg font-semibold">Identity</h2>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          {profile?.display_name && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Name</dt>
              <dd className="text-right">{profile.display_name}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Email</dt>
            <dd className="text-right">{user.email}</dd>
          </div>
          {roleLabel && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Role</dt>
              <dd className="text-right">{roleLabel}</dd>
            </div>
          )}
        </dl>
      </SurfaceCard>

      <SurfaceCard className="mt-4">
        <h2 className="font-serif text-lg font-semibold">Purchases & refunds</h2>
        <p className="mt-1 text-sm text-muted">
          View your purchase history and manage eligible refund requests.
        </p>
        <Link
          href="/account/purchases"
          className={`mt-3 inline-flex ${buttonClasses("outline", "sm")}`}
        >
          View purchases & refunds
        </Link>
      </SurfaceCard>

      <SurfaceCard className="mt-4">
        <Link
          href={isAuthor ? "/dashboard" : "/library"}
          className={`focus-ring inline-flex ${buttonClasses("outline", "sm")}`}
        >
          {isAuthor ? "Go to Dashboard" : "Go to Library"}
        </Link>
      </SurfaceCard>

      <form action={logout} className="mt-6">
        <button type="submit" className="focus-ring rounded-sm text-sm text-muted hover:underline">
          Sign out
        </button>
      </form>

      <section className="mt-10 rounded-lg border-l-4 border-red-600 bg-surface p-6">
        <h2 className="font-serif text-lg font-semibold text-red-800">Danger zone</h2>
        <p className="mt-2 text-sm text-foreground/90">
          Delete account. This permanently deletes your account
          {isAuthor
            ? ", every book you've published, and their files"
            : " and removes your access to your library"}
          . This can&apos;t be undone.
          {!isAuthor && (
            <>
              {" "}
              Some transaction records may be retained, detached from your
              account, where necessary for payment accounting, refunds,
              disputes, or legal obligations.
            </>
          )}
        </p>

        {error && (
          <Alert variant="error" className="mt-3">
            {error}
          </Alert>
        )}

        <form action={deleteAccount} className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Type DELETE to confirm
            <input name="confirmation" type="text" required className={formControlClasses} />
          </label>
          <button type="submit" className={`w-fit ${buttonClasses("danger", "md")}`}>
            Permanently delete my account
          </button>
        </form>
      </section>
    </main>
  );
}
