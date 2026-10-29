import Link from "next/link";
import { login } from "@/app/(public)/auth/actions";
import { translateAuthErrorMessage } from "@/lib/auth-error";
import { authSuccessMessage } from "@/lib/auth-page-messages";
import { Alert } from "@/components/ui/alert";
import { SUSPENDED_MESSAGE } from "@/lib/suspension-gate";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hyni",
  description: "Hyni në llogarinë tuaj në Librum.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; next?: string; suspended?: string }>;
}) {
  const { error, success, next, suspended } = await searchParams;
  // SQ-16: only Librum's own success line, never text from the address.
  const successMessage = authSuccessMessage(success);

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4 py-10">
      <h1 className="font-serif text-3xl font-normal">Hyni</h1>
      <p className="mt-1 text-sm text-muted">Mirë se u kthyet në Librum.</p>

      {/* PEOPLE-2: set only by Proxy when it cuts off a suspended
          session. A banned sign-in gets the wrong-password message
          instead (login(), option a). */}
      {suspended === "1" && (
        <Alert variant="error" className="mt-4">
          {SUSPENDED_MESSAGE}
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mt-4">
          {translateAuthErrorMessage(error)}
        </Alert>
      )}
      {successMessage && (
        <Alert variant="success" className="mt-4">
          {successMessage}
        </Alert>
      )}

      <form action={login} className="mt-6 flex flex-col gap-4">
        {next && <input type="hidden" name="next" value={next} />}
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
            autoComplete="current-password"
            required
            className={formControlClasses}
          />
        </label>

        <button type="submit" className={`mt-2 ${buttonClasses("primary", "md")}`}>
          Hyni
        </button>
      </form>

      <p className="mt-4 text-sm text-muted">
        <Link href="/forgot-password" className="focus-ring rounded-sm underline underline-offset-2 hover:decoration-2">
          Keni harruar fjalëkalimin?
        </Link>
      </p>

      <p className="mt-2 text-sm text-muted">
        Nuk keni ende llogari?{" "}
        <Link href="/signup" className="focus-ring rounded-sm font-medium text-primary underline">
          Regjistrohuni
        </Link>
      </p>
    </main>
  );
}
