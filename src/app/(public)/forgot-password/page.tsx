import Link from "next/link";
import { requestPasswordReset } from "@/app/(public)/auth/actions";
import { translateAuthErrorMessage } from "@/lib/auth-error";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Reset password",
  description: "Request a password reset link for your Librum account.",
};

export default async function ForgotPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4">
      <h1 className="font-serif text-3xl font-semibold">Reset your password</h1>

      {error && (
        <Alert variant="error" className="mt-4">
          {translateAuthErrorMessage(error)}
        </Alert>
      )}

      {success ? (
        <Alert variant="success" className="mt-4">
          If that email has an account, we&apos;ve sent a link to reset your
          password.
        </Alert>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            Enter your email and we&apos;ll send you a password reset link.
          </p>

          <form action={requestPasswordReset} className="mt-6 flex flex-col gap-4">
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

            <button type="submit" className={`mt-2 ${buttonClasses("primary", "md")}`}>
              Send reset link
            </button>
          </form>
        </>
      )}

      <p className="mt-6 text-sm text-muted">
        <Link href="/login" className="focus-ring rounded-sm font-medium text-primary underline">
          Back to log in
        </Link>
      </p>
    </main>
  );
}
