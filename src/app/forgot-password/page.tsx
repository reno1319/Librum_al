import Link from "next/link";
import { requestPasswordReset } from "@/app/auth/actions";

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
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      {success ? (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          If that email has an account, we&apos;ve sent a link to reset
          your password.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">
            Enter your email and we&apos;ll send you a link to set a new
            password.
          </p>

          <form
            action={requestPasswordReset}
            className="mt-6 flex flex-col gap-4"
          >
            <label className="flex flex-col gap-1 text-sm">
              Email
              <input
                name="email"
                type="email"
                required
                className="rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>

            <button
              type="submit"
              className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Send reset link
            </button>
          </form>
        </>
      )}

      <p className="mt-6 text-sm text-muted">
        <Link href="/login" className="font-medium text-primary underline">
          Back to log in
        </Link>
      </p>
    </main>
  );
}
