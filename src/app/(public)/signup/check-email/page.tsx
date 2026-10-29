import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Shikoni emailin",
  description: "Konfirmoni emailin për të aktivizuar llogarinë tuaj në Librum.",
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
      <h1 className="font-serif text-3xl font-normal">Shikoni emailin</h1>
      <p className="mt-3 text-sm text-muted">
        Ju dërguam një lidhje konfirmimi. Klikojeni për të aktivizuar llogarinë, pastaj
        hyni.
      </p>
      {author === "pending" && (
        <p className="mt-3 text-sm text-muted">
          Llogaria juaj u krijua si llogari lexuesi. Për të botuar, hyni dhe përdorni
          &ldquo;Bëhuni autor&rdquo; te faqja Llogaria.
        </p>
      )}
      <p className="mt-6 text-sm text-muted">
        <Link href="/login" className="focus-ring rounded-sm font-medium text-primary underline">
          Kthehuni te hyrja
        </Link>
      </p>
    </main>
  );
}
