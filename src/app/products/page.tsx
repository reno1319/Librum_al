import Link from "next/link";

export default function ProductsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-4xl font-semibold">Products</h1>

      <p className="mt-6 text-foreground/90">
        Today, Librum is ebooks — upload an EPUB, set a price, and sell
        directly to readers. A dedicated overview of everything Librum
        offers (including print, further down the line) is coming soon.
      </p>

      <p className="mt-6">
        <Link href="/how-it-works" className="text-primary underline">
          See how self-publishing on Librum works &rarr;
        </Link>
      </p>
    </main>
  );
}
