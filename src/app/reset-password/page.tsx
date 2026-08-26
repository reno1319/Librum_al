import { updatePassword } from "@/app/auth/actions";
import { translateAuthErrorMessage } from "@/lib/auth-error";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4">
      <h1 className="font-serif text-3xl font-semibold">Set a new password</h1>
      <p className="mt-1 text-sm text-muted">
        You&apos;re completing a password reset. Set a new password to continue.
      </p>

      {error && (
        <Alert variant="error" className="mt-4">
          {translateAuthErrorMessage(error)}
        </Alert>
      )}

      <form action={updatePassword} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          New password
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Confirm new password
          <input
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            minLength={6}
            className={formControlClasses}
          />
        </label>

        <button type="submit" className={`mt-2 ${buttonClasses("primary", "md")}`}>
          Update password
        </button>
      </form>
    </main>
  );
}
