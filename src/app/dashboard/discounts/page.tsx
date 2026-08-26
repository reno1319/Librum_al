import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createDiscountCode, toggleDiscountCode, deleteDiscountCode } from "./actions";
import type { Book, DiscountCode } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Discounts",
};

type DiscountCodeWithBook = DiscountCode & { books: Pick<Book, "title"> | null };

export default async function DiscountsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: books } = await supabase
    .from("books")
    .select("id, title")
    .eq("author_id", user!.id)
    .order("title")
    .returns<Pick<Book, "id" | "title">[]>();

  const { data: codes } = await supabase
    .from("discount_codes")
    .select("*, books(title)")
    .eq("author_id", user!.id)
    .order("created_at", { ascending: false })
    .returns<DiscountCodeWithBook[]>();

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Discount codes</h1>
      <p className="mt-1 text-sm text-muted">
        Create a promo code for one of your books — readers enter it at
        checkout for a percentage or fixed amount off.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      {success && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
          {success}
        </p>
      )}

      {!books || books.length === 0 ? (
        <p className="mt-6 rounded-lg border border-dashed border-border px-6 py-10 text-center text-sm text-muted">
          You need at least one book before you can create a discount code.
        </p>
      ) : (
        <form
          action={createDiscountCode}
          className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
        >
          <label className="flex flex-col gap-1 text-sm">
            Book
            <select
              name="bookId"
              required
              defaultValue=""
              className="rounded-lg border border-border bg-surface px-3 py-2"
            >
              <option value="" disabled>
                Choose a book
              </option>
              {books.map((book) => (
                <option key={book.id} value={book.id}>
                  {book.title}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Code
            <input
              name="code"
              type="text"
              required
              placeholder="e.g. LAUNCH20"
              className="rounded-lg border border-border bg-surface px-3 py-2 uppercase"
            />
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Discount type
              <select
                name="type"
                required
                defaultValue="percent"
                className="rounded-lg border border-border bg-surface px-3 py-2"
              >
                <option value="percent">Percentage off</option>
                <option value="amount">Fixed amount off (USD)</option>
              </select>
            </label>

            <label className="flex flex-1 flex-col gap-1 text-sm">
              Value
              <input
                name="value"
                type="number"
                min="0"
                step="0.01"
                required
                placeholder="e.g. 20"
                className="rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            Expires (optional)
            <input
              name="expiresAt"
              type="date"
              className="rounded-lg border border-border bg-surface px-3 py-2"
            />
          </label>

          <button
            type="submit"
            className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Create code
          </button>
        </form>
      )}

      <ul className="mt-8 flex flex-col gap-3">
        {(codes ?? []).map((code) => {
          const expired =
            !!code.expires_at && new Date(code.expires_at) < new Date();
          const value =
            code.percent_off != null
              ? `${code.percent_off}% off`
              : `$${((code.amount_off_cents ?? 0) / 100).toFixed(2)} off`;

          return (
            <li
              key={code.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm"
            >
              <div>
                <p className="font-medium">
                  {code.code} <span className="text-muted">· {value}</span>
                </p>
                <p className="text-xs text-muted">
                  {code.books?.title}
                  {code.expires_at &&
                    ` · ${expired ? "Expired" : "Expires"} ${new Date(code.expires_at).toLocaleDateString()}`}
                  {!code.active && " · Disabled"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <form action={toggleDiscountCode.bind(null, code.id, code.active)}>
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
                  >
                    {code.active ? "Disable" : "Enable"}
                  </button>
                </form>
                <form action={deleteDiscountCode.bind(null, code.id)}>
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-surface-hover"
                  >
                    Delete
                  </button>
                </form>
              </div>
            </li>
          );
        })}
        {(codes ?? []).length === 0 && (
          <p className="text-sm text-muted">No discount codes yet.</p>
        )}
      </ul>
    </main>
  );
}
