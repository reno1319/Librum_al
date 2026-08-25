import Link from "next/link";
import { signup } from "@/app/auth/actions";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; role?: string }>;
}) {
  const { error, role } = await searchParams;
  const authorPreselected = role === "author";

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4">
      <h1 className="font-serif text-3xl font-semibold">Sign up</h1>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form action={signup} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Name
          <input
            name="displayName"
            type="text"
            required
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            required
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            required
            minLength={6}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <fieldset
          className="text-sm"
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          <legend className="mb-1">I am signing up as a...</legend>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="role"
              value="reader"
              defaultChecked={!authorPreselected}
            />
            Reader — I want to buy and read ebooks
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="role"
              value="author"
              defaultChecked={authorPreselected}
            />
            Author — I want to publish and sell ebooks
          </label>
        </fieldset>

        <div className="flex items-start gap-2 text-sm">
          <input
            id="accept_terms"
            name="accept_terms"
            type="checkbox"
            required
            className="mt-1"
          />
          <label htmlFor="accept_terms">
            I agree to the{" "}
            <Link href="/terms" className="font-medium text-primary underline">
              Terms of Service
            </Link>{" "}
            and acknowledge the{" "}
            <Link href="/privacy" className="font-medium text-primary underline">
              Privacy Policy
            </Link>
            .
          </label>
        </div>

        <button
          type="submit"
          className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Create account
        </button>
      </form>

      <p className="mt-6 text-sm text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-primary underline">
          Log in
        </Link>
      </p>
    </main>
  );
}
