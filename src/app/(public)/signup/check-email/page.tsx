import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Check your email",
  description: "Confirm your email to activate your Librum account.",
};

export default async function CheckEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ author?: string }>;
}) {
  // SECURITY-9A (Renato, "2. a"): an author sign-up whose switch to
  // author failed made a reader account; one line says what to do.
  const { author } = await searchParams;
  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col items-center justify-center px-4 text-center">
      <h1 className="font-serif text-3xl font-normal">Check your email</h1>
      <p className="mt-3 text-sm text-muted">
        We sent you a confirmation link. Click it to activate your account, then
        log in.
      </p>
      {author === "pending" && (
        <p className="mt-3 text-sm text-muted">
          Your account was created as a reader account. To publish, log in and use
          &ldquo;Become an author&rdquo; on your Account page.
        </p>
      )}
      <p className="mt-6 text-sm text-muted">
        <Link href="/login" className="focus-ring rounded-sm font-medium text-primary underline">
          Back to log in
        </Link>
      </p>
    </main>
  );
}
