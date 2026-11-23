import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { updateProfile } from "./actions";
import { createPenName, deletePenName, updatePenName } from "../pen-names/actions";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { AvatarField } from "@/components/avatar-field";
import { formControlClasses } from "@/lib/form-styles";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/lib/account-name";
import {
  PEN_NAME_BIO_MAX_LENGTH,
  PEN_NAME_LINK_MAX_LENGTH,
  PEN_NAME_MAX_LENGTH,
  PEN_NAME_MAX_LINKS,
  authorPagePath,
  readPenNameLinks,
  type OwnPenName,
} from "@/lib/pen-names";
import type { Profile } from "@/lib/types";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Profili",
};

const MAIN_CARD_FORM_ID = "main-author-card";

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
        .select("display_name")
        .eq("id", user.id)
        .single<Pick<Profile, "display_name">>(),
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

  function penNameCard(penName: OwnPenName) {
    const isMain = penName.is_default;
    const links = readPenNameLinks(penName.links);
    const count = bookCount.get(penName.id) ?? 0;
    const used = count > 0 || usedBySeriesOrBundle.has(penName.id);
    const photoUrl = penName.avatar_path
      ? supabase.storage.from("avatars").getPublicUrl(penName.avatar_path).data.publicUrl
      : null;
    const Heading = isMain ? "h2" : "h3";

    return (
      <div className="rounded-card border border-border bg-surface p-4 shadow-sm sm:p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Heading className="min-w-0 break-words font-serif text-xl font-normal text-primary">{penName.name}</Heading>
          <p className="text-xs text-muted">
            {count} {count === 1 ? "libër" : "libra"}
          </p>
        </div>
        {isMain && <p className="mt-1 text-sm text-muted">Ky emër shfaqet te librat tuaj dhe te faqja juaj e autorit.</p>}
        {used && (
          <Link
            href={authorPagePath(penName.id)}
            className="focus-ring mt-1 inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
          >
            Shikoni faqen e autorit &rarr;
          </Link>
        )}

        <form
          id={isMain ? MAIN_CARD_FORM_ID : undefined}
          action={updatePenName.bind(null, penName.id)}
          className="mt-4 flex flex-col gap-4"
        >
          <AvatarField userId={user!.id} existingAvatarUrl={photoUrl} />
          {photoUrl && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="removePhoto" className="focus-ring size-4" />
              Hiqeni foton
            </label>
          )}

          <label className="flex flex-col gap-1 text-sm">
            {isMain ? "Emri juaj i autorit" : "Emri"}
            <input
              name="name"
              type="text"
              required
              maxLength={PEN_NAME_MAX_LENGTH}
              defaultValue={penName.name}
              className={formControlClasses}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Biografia (opsionale)
            <textarea
              name="bio"
              rows={4}
              maxLength={PEN_NAME_BIO_MAX_LENGTH}
              defaultValue={penName.bio ?? ""}
              placeholder={
                isMain
                  ? "Disa fjali për ju, që lexuesit i shohin në faqen tuaj të autorit."
                  : "Disa fjali që lexuesit i shohin në faqen e autorit të këtij pseudonimi."
              }
              className={formControlClasses}
            />
          </label>

          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1">Lidhjet (opsionale, deri në {PEN_NAME_MAX_LINKS})</legend>
            {Array.from({ length: PEN_NAME_MAX_LINKS }, (_, i) => (
              <input
                key={i}
                name="links"
                type="url"
                inputMode="url"
                maxLength={PEN_NAME_LINK_MAX_LENGTH}
                pattern="https://.*"
                placeholder="https://"
                aria-label={`Lidhja ${i + 1}`}
                defaultValue={links[i] ?? ""}
                className={formControlClasses}
              />
            ))}
            <span className="text-muted">Adresa të plota interneti që fillojnë me https://.</span>
          </fieldset>

          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={buttonClasses("primary", "md")}>
              Ruani
            </button>
          </div>
        </form>

        {!isMain && !used && (
          <form action={deletePenName.bind(null, penName.id)} className="mt-3">
            <button
              type="submit"
              className="focus-ring rounded-full border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
            >
              Fshini pseudonimin
            </button>
          </form>
        )}
      </div>
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
