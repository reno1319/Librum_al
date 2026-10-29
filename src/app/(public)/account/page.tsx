import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/(public)/auth/actions";
import { deleteAccount } from "./actions";
import { becomeAuthor } from "./become-author";
import { AUTHOR_AGE_FIELD, AUTHOR_AGE_STATEMENT } from "@/lib/author-age-statement";
import { PageHeader } from "@/components/ui/page-header";
import { SurfaceCard } from "@/components/ui/surface-card";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Llogaria",
  description: "Menaxhoni llogarinë tuaj në Librum.",
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
  const roleLabel = isAuthor ? "Autor" : profile?.role === "reader" ? "Lexues" : null;

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-10">
      <PageHeader
        title="Llogaria"
        description="Menaxhoni llogarinë tuaj në Librum dhe shikoni historikun e saj."
      />

      <SurfaceCard className="mt-8">
        <h2 className="font-serif text-lg font-normal">Të dhënat</h2>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          {profile?.display_name && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Emri</dt>
              <dd className="text-right">{profile.display_name}</dd>
            </div>
          )}
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Adresa e emailit</dt>
            <dd className="text-right">{user.email}</dd>
          </div>
          {roleLabel && (
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Roli</dt>
              <dd className="text-right">{roleLabel}</dd>
            </div>
          )}
        </dl>
      </SurfaceCard>

      <SurfaceCard className="mt-4">
        <h2 className="font-serif text-lg font-normal">Blerjet dhe rimbursimet</h2>
        <p className="mt-1 text-sm text-muted">
          Shikoni blerjet tuaja dhe menaxhoni kërkesat për rimbursim që lejohen.
        </p>
        <Link
          href="/account/purchases"
          className={`mt-3 inline-flex ${buttonClasses("outline", "sm")}`}
        >
          Shikoni blerjet dhe rimbursimet
        </Link>
      </SurfaceCard>

      <SurfaceCard className="mt-4">
        <div className="flex flex-wrap gap-3">
          {isAuthor && (
            <Link
              href="/dashboard"
              className={`focus-ring inline-flex ${buttonClasses("outline", "sm")}`}
            >
              Shkoni te Paneli i autorit
            </Link>
          )}
          {/* BECOME-AUTHOR-1: an author keeps the books they bought, and a
              reader who became an author is the most likely to have
              some -- so the Library link stays for authors too. */}
          <Link
            href="/library"
            className={`focus-ring inline-flex ${buttonClasses("outline", "sm")}`}
          >
            Shkoni te Biblioteka ime
          </Link>
        </div>
      </SurfaceCard>

      {profile?.role === "reader" && (
        <div id="become-author">
          <SurfaceCard className="mt-4">
            <h2 className="font-serif text-lg font-normal">Botoni librat tuaj</h2>
            <p className="mt-1 text-sm text-muted">
              Kaloni në llogari autori për të botuar dhe shitur libra elektronikë. Biblioteka
              dhe blerjet tuaja mbeten. Emri juaj publik i autorit do të jetë fillimisht{" "}
              <span className="font-medium text-foreground">{profile.display_name}</span>;
              mund ta ndryshoni te profili i autorit. Një llogari autori nuk mund të
              kthehet më në llogari lexuesi.
            </p>
            {/* AUTHOR-AGE-1: the Terms' 18+ rule; becomeAuthor checks the
                tick again and records it. SECURITY-9A adds the Terms tick. */}
            <form action={becomeAuthor} className="mt-3">
              <div className="mb-3 flex items-start gap-2 text-sm">
                <input
                  id={AUTHOR_AGE_FIELD}
                  name={AUTHOR_AGE_FIELD}
                  type="checkbox"
                  required
                  className="focus-ring mt-1 size-4"
                />
                <label htmlFor={AUTHOR_AGE_FIELD}>{AUTHOR_AGE_STATEMENT}</label>
              </div>
              {/* SECURITY-9A: the Terms tick, always (Renato, "2. a");
                  becomeAuthor checks it again and records it. */}
              <div className="mb-3 flex items-start gap-2 text-sm">
                <input
                  id="become_author_accept_terms"
                  name="accept_terms"
                  type="checkbox"
                  required
                  className="focus-ring mt-1 size-4"
                />
                <label htmlFor="become_author_accept_terms">
                  Pranoj{" "}
                  <Link href="/kushtet" className="focus-ring rounded-sm font-medium text-primary underline">
                    Kushtet e përdorimit
                  </Link>
                  .
                </label>
              </div>
              <button type="submit" className={buttonClasses("primary", "sm")}>
                Bëhuni autor
              </button>
            </form>
          </SurfaceCard>
        </div>
      )}

      <form action={logout} className="mt-6">
        <button type="submit" className="focus-ring rounded-sm text-sm text-muted hover:underline">
          Dilni
        </button>
      </form>

      <section className="mt-10 rounded-card border-l-4 border-red-600 bg-surface p-6">
        <h2 className="font-serif text-lg font-normal text-red-800">Zonë rreziku</h2>
        <p className="mt-2 text-sm text-foreground/90">
          Fshirja e llogarisë. Kjo fshin përgjithmonë llogarinë tuaj
          {isAuthor
            ? ", çdo libër që keni botuar dhe skedarët e tyre"
            : " dhe ju heq aksesin te biblioteka juaj"}
          . Ky veprim nuk kthehet pas.
          {!isAuthor && (
            <>
              {" "}
              Disa të dhëna transaksionesh mund të ruhen, të shkëputura nga llogaria
              juaj, kur nevojiten për kontabilitetin e pagesave, rimbursimet,
              mosmarrëveshjet ose detyrimet ligjore.
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
            Shkruani FSHI për ta konfirmuar
            <input name="confirmation" type="text" required className={formControlClasses} />
          </label>
          <button type="submit" className={`w-fit ${buttonClasses("danger", "md")}`}>
            Fshini përgjithmonë llogarinë time
          </button>
        </form>
      </section>
    </main>
  );
}
