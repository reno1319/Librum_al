import Link from "next/link";
import { createBook } from "../actions";

export default async function NewBookPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto w-full max-w-lg flex-1 px-6 py-10">
      <Link href="/dashboard" className="text-sm text-gray-500 hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 text-2xl font-semibold">Add a new book</h1>
      <p className="mt-1 text-sm text-gray-600">
        It&apos;s saved as a draft first — you can publish it from your
        dashboard once you&apos;re happy with it.
      </p>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form action={createBook} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input
            name="title"
            type="text"
            required
            className="rounded-md border border-gray-300 px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Description
          <textarea
            name="description"
            rows={4}
            className="rounded-md border border-gray-300 px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Price (USD)
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            defaultValue="0"
            required
            className="rounded-md border border-gray-300 px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Cover image (JPG or PNG, up to 5MB)
          <input
            name="cover"
            type="file"
            accept="image/png,image/jpeg"
            required
            className="text-sm"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Manuscript (EPUB file, up to 50MB)
          <input
            name="manuscript"
            type="file"
            accept=".epub,application/epub+zip"
            required
            className="text-sm"
          />
        </label>

        <button
          type="submit"
          className="mt-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
        >
          Save as draft
        </button>
      </form>
    </main>
  );
}
