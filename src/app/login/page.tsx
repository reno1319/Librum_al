import Link from "next/link";
import { login } from "@/app/auth/actions";
import { translateAuthErrorMessage } from "@/lib/auth-error";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Log in",
  description: "Log in to your Librum account.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string; next?: string }>;
}) {
  const { error, success, next } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4">
      <h1 className="font-serif text-3xl font-semibold">Log in</h1>
      <p className="mt-1 text-sm text-muted">Welcome back to Librum.</p>

      {error && (
        <Alert variant="error" className="mt-4">
          {translateAuthErrorMessage(error)}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      <form action={login} className="mt-6 flex flex-col gap-4">
        {next && <input type="hidden" name="next" value={next} />}
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={formControlClasses}
          />
        </label>

        <button type="submit" className={`mt-2 ${buttonClasses("primary", "md")}`}>
          Log in
        </button>
      </form>

      <p className="mt-4 text-sm text-muted">
        <Link href="/forgot-password" className="focus-ring rounded-sm hover:underline">
          Forgot your password?
        </Link>
      </p>

      <p className="mt-2 text-sm text-muted">
        No account yet?{" "}
        <Link href="/signup" className="focus-ring rounded-sm font-medium text-primary underline">
          Sign up
        </Link>
      </p>
    </main>
  );
}
