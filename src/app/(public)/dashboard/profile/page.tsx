import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "./actions";
import { createPenName } from "../pen-names/actions";
import { MAIN_CARD_FORM_ID, PenNameCard } from "./pen-name-card";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/lib/account-name";
import { PEN_NAME_MAX_LENGTH, type OwnPenName } from "@/lib/pen-names";
import type { Profile } from "@/lib/types";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Profili",
};

// AUTHOR PROFILI (build 1, approved picture sp2 a): one Profili page for
// authors (the dashboard is author-only). Top to bottom: the private
// account name, the main author name card (the default pen name: photo,
// name, bio, links), then "Pseudonimet (opsionale)" with "+ Shto
// pseudonim" and one card per other pen name. Readers' profile is
// /account and is unchanged.
//
// One writer per value: the main card's Ruani saves the account name
// (Q1 b) and the default pen name through updatePenName; the author name
// IS the default pen name's name, synced to profiles.public_author_name
// by the database. updateProfile is used only by the fallback below.
export default async function EditProfilePage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  // updateProfile (the fallback form) sends success=1: any other
  // non-listed value shows the same fixed text, as this page always did.
  const success = pageSuccessMessage(rawSuccess) ?? (rawSuccess ? "Profili u ruajt." : null);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/profile");
  }

  const [{ data: profile }, { data: penNames }, { data: books }, { data: series }, { data: bundles }] =
    await Promise.all([
      supabase
        .from("profiles")
        .select("display_name, account_kind")
        .eq("id", user.id)
        .single<Pick<Profile, "display_name"> & { account_kind?: string | null }>(),
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

  const mainPenName = (penNames ?? []).find((p) => p.is_default) ?? null;
  const otherPenNames = (penNames ?? []).filter((p) => !p.is_default);

  const isHouse = profile?.account_kind === "publishing_house";

  function penNameCard(penName: OwnPenName) {
    const isMain = penName.is_default;
    const count = bookCount.get(penName.id) ?? 0;
    const photoUrl = penName.avatar_path
      ? supabase.storage.from("avatars").getPublicUrl(penName.avatar_path).data.publicUrl
      : null;
    return (
      <PenNameCard
        kind={isMain ? (isHouse ? "house" : "main") : "pseudonym"}
        penName={penName}
        userId={user!.id}
        photoUrl={photoUrl}
        bookCount={count}
        used={
          // BUILD 2b: the house page is there once the house has a book.
          isMain && isHouse ? (books ?? []).length > 0 : count > 0 || usedBySeriesOrBundle.has(penName.id)
        }
      />
    );
  }

  const accountNameField = (
    <label className="flex flex-col gap-1 text-sm">
      Emri i llogarisë
      <input
        name="displayName"
        type="text"
        required
        maxLength={ACCOUNT_NAME_MAX_LENGTH}
        defaultValue={profile?.display_name}
        // Q1 b: saved by the main card's Ruani (the form it belongs to).
        form={mainPenName ? MAIN_CARD_FORM_ID : undefined}
        className={formControlClasses}
      />
      {/* LIBRUM 2.0 AUTHOR-1A: account/private identity only, never a
          claim of legal accuracy; never used for author attribution
          (resolvePublicAuthorName() everywhere). */}
      <span className="text-sm text-muted">Vetëm për llogarinë tuaj. Lexuesit nuk e shohin.</span>
    </label>
  );

  // BUILD 2a-2 (approved picture 6): a publishing house's Profili is
  // only its own card (name, logo, about, links); its authors are on
  // Autorët. No account name field and no pseudonyms section.
  if (isHouse) {
    return (
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
        <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
          &larr; Kthehuni te paneli
        </Link>

        <div className="mt-2">
          <PageHeader title="Profili" description="Faqja publike e shtëpisë suaj botuese. Autorët i shtoni te Autorët." />
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

        {mainPenName ? (
          <div className="mt-6">{penNameCard(mainPenName)}</div>
        ) : (
          <Alert variant="error" className="mt-6">
            Profili nuk u lexua dot. Rifreskoni faqen.
          </Alert>
        )}
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-10 sm:px-6 sm:pt-8">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Kthehuni te paneli
      </Link>

      <div className="mt-2">
        <PageHeader title="Profili" description="Emri i llogarisë, emri juaj i autorit dhe pseudonimet, nëse keni." />
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

      {mainPenName ? (
        <>
          <div className="mt-6">{accountNameField}</div>
          <div className="mt-6">{penNameCard(mainPenName)}</div>
        </>
      ) : (
        // An author always has a default pen name (database trigger); if
        // it can't be read, the account name still saves on its own.
        <form action={updateProfile} className="mt-6 flex flex-col gap-4">
          {accountNameField}
          <button type="submit" className={buttonClasses("primary", "md", "self-start")}>
            Ruani
          </button>
        </form>
      )}

      <section aria-labelledby="pen-names-heading" className="mt-12">
        <h2 id="pen-names-heading" className="font-serif text-2xl font-normal text-primary">
          Pseudonimet (opsionale)
        </h2>
        <p className="mt-1 text-sm text-muted">
          Botoni me një emër tjetër? Shtoni një pseudonim. Çdo pseudonim ka faqen e vet; e zgjidhni për çdo libër.
        </p>

        {/* Q2 a: the button opens a small name box; nothing is saved until
            a name is typed. <details> works without JavaScript. */}
        <details className="group mt-4">
          <summary className={buttonClasses("primary", "md", "inline-flex cursor-pointer list-none [&::-webkit-details-marker]:hidden")}>
            + Shto pseudonim
          </summary>
          <form action={createPenName} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Emri i pseudonimit
              <input name="name" type="text" required maxLength={PEN_NAME_MAX_LENGTH} className={formControlClasses} />
            </label>
            <button type="submit" className={buttonClasses("primary", "md", "self-start sm:self-auto")}>
              Shto
            </button>
          </form>
        </details>

        {otherPenNames.length > 0 && (
          <ul className="mt-6 flex flex-col gap-6">
            {otherPenNames.map((penName) => (
              <li key={penName.id}>{penNameCard(penName)}</li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
