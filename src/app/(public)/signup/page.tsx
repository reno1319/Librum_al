import Link from "next/link";
import { signup } from "@/app/(public)/auth/actions";
import { translateAuthErrorMessage } from "@/lib/auth-error";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import { AUTHOR_AGE_FIELD, AUTHOR_AGE_STATEMENT } from "@/lib/author-age-statement";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/lib/account-name";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Krijoni llogari",
  description: "Krijoni një llogari në Librum për të botuar ose për të blerë libra elektronikë.",
};

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; role?: string }>;
}) {
  const { error, role } = await searchParams;
  const authorPreselected = role === "author";

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="font-serif text-3xl font-normal">Regjistrohuni</h1>

      {error && (
        <Alert variant="error" className="mt-4">
          {translateAuthErrorMessage(error)}
        </Alert>
      )}

      <form action={signup} className="group mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Emri
          <input
            name="displayName"
            type="text"
            autoComplete="name"
            required
            maxLength={ACCOUNT_NAME_MAX_LENGTH}
            className={formControlClasses}
          />
          {/* PEN-NAMES-1 (6a). */}
          <span className="text-sm text-muted">
            Nëse regjistroheni si autor, lexuesit e shohin këtë si emrin tuaj të autorit. Pseudonimin
            mund ta vendosni më vonë.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Adresa e emailit
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Fjalëkalimi
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            className={formControlClasses}
          />
          <span className="text-sm text-muted">Të paktën 6 karaktere.</span>
        </label>

        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Regjistrohem si...</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="role"
              value="reader"
              defaultChecked={!authorPreselected}
            />
            Lexues: dua të blej dhe të lexoj libra elektronikë
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="role"
              value="author"
              defaultChecked={authorPreselected}
            />
            Autor: dua të botoj dhe të shes libra elektronikë
          </label>
          {/* AUTHOR-AGE-1: shown only while "Author" is chosen (CSS
              :has(), no script). Not `required`: a hidden required box
              would block a reader's sign-up, so signup() checks it on the
              server and refuses an author sign-up without it. */}
          <div className="ml-6 hidden items-start gap-2 group-has-[[value=author]:checked]:flex">
            <input
              id={AUTHOR_AGE_FIELD}
              name={AUTHOR_AGE_FIELD}
              type="checkbox"
              className="focus-ring mt-1 size-4"
            />
            <label htmlFor={AUTHOR_AGE_FIELD}>{AUTHOR_AGE_STATEMENT}</label>
          </div>
        </fieldset>

        <div className="flex items-start gap-2 text-sm">
          <input
            id="accept_terms"
            name="accept_terms"
            type="checkbox"
            required
            className="focus-ring mt-1 size-4"
          />
          <label htmlFor="accept_terms">
            Pranoj{" "}
            <Link href="/terms" className="focus-ring rounded-sm font-medium text-primary underline">
              Kushtet e përdorimit
            </Link>{" "}
            dhe kam lexuar{" "}
            <Link href="/privacy" className="focus-ring rounded-sm font-medium text-primary underline">
              Politikën e privatësisë
            </Link>
            .
          </label>
        </div>

        <button type="submit" className={`mt-2 ${buttonClasses("primary", "md")}`}>
          Krijoni llogarinë
        </button>
      </form>

      <p className="mt-6 text-sm text-muted">
        Keni tashmë llogari?{" "}
        <Link href="/login" className="focus-ring rounded-sm font-medium text-primary underline">
          Hyni
        </Link>
      </p>
    </main>
  );
}
