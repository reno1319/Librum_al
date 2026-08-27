import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createDiscountCode, toggleDiscountCode, deleteDiscountCode } from "./actions";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
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
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Discount codes"
          description="Create a promo code for one of your books — readers enter it at checkout for a percentage or fixed amount off."
        />
      </div>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {!books || books.length === 0 ? (
        <EmptyState
          className="mt-6"
          title="You need at least one book before you can create a discount code."
        />
      ) : (
        <form
          action={createDiscountCode}
          className="mt-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
        >
          <label className="flex flex-col gap-1 text-sm">
            Book
            <select name="bookId" required defaultValue="" className={formControlClasses}>
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
              className={`uppercase ${formControlClasses}`}
            />
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Discount type
              <select name="type" required defaultValue="percent" className={formControlClasses}>
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
                className={formControlClasses}
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-sm">
            Expires (optional)
            <input name="expiresAt" type="date" className={formControlClasses} />
          </label>

          <button type="submit" className={buttonClasses("primary", "md", "w-fit")}>
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
                    className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-hover"
                  >
                    {code.active ? "Disable" : "Enable"}
                  </button>
                </form>
                <form action={deleteDiscountCode.bind(null, code.id)}>
                  <button
                    type="submit"
                    className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
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
