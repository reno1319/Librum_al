import Link from "next/link";

export default function CheckEmailPage() {
  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col items-center justify-center px-4 text-center">
      <h1 className="font-serif text-3xl font-semibold">Check your email</h1>
      <p className="mt-3 text-sm text-muted">
        We sent you a confirmation link. Click it to activate your account, then
        log in.
      </p>
      <p className="mt-6 text-sm text-muted">
        <Link href="/login" className="focus-ring rounded-sm font-medium text-primary underline">
          Back to log in
        </Link>
      </p>
    </main>
  );
}
