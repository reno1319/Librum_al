import { createClient } from "@/lib/supabase/server";
import { platformFeeCents } from "@/lib/pricing";
import type { Book } from "@/lib/types";

const CHART_DAYS = 14;

type Purchase = {
  book_id: string;
  amount_cents: number;
  created_at: string;
};

function netCents(amountCents: number) {
  return amountCents - platformFeeCents(amountCents);
}

export default async function SalesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: books } = await supabase
    .from("books")
    .select("id, title, status")
    .eq("author_id", user!.id)
    .returns<Pick<Book, "id" | "title" | "status">[]>();

  const bookIds = (books ?? []).map((book) => book.id);

  const { data: purchases } =
    bookIds.length > 0
      ? await supabase
          .from("purchases")
          .select("book_id, amount_cents, created_at")
          .in("book_id", bookIds)
          .is("refunded_at", null)
          .returns<Purchase[]>()
      : { data: [] as Purchase[] };

  const { data: views } =
    bookIds.length > 0
      ? await supabase
          .from("book_views")
          .select("book_id")
          .in("book_id", bookIds)
          .returns<{ book_id: string }[]>()
      : { data: [] as { book_id: string }[] };

  const allPurchases = purchases ?? [];
  const allViews = views ?? [];
  const totalUnitsSold = allPurchases.length;
  const totalViews = allViews.length;
  const totalNetCents = allPurchases.reduce(
    (sum, p) => sum + netCents(p.amount_cents),
    0,
  );
  const publishedCount =
    books?.filter((book) => book.status === "published").length ?? 0;

  const perBook = (books ?? []).map((book) => {
    const bookPurchases = allPurchases.filter((p) => p.book_id === book.id);
    const bookViews = allViews.filter((v) => v.book_id === book.id).length;
    return {
      id: book.id,
      title: book.title,
      unitsSold: bookPurchases.length,
      views: bookViews,
      netCents: bookPurchases.reduce((sum, p) => sum + netCents(p.amount_cents), 0),
    };
  });
  perBook.sort((a, b) => b.netCents - a.netCents);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() - (CHART_DAYS - 1 - i));
    return { date, cents: 0 };
  });

  for (const purchase of allPurchases) {
    const purchaseDate = new Date(purchase.created_at);
    purchaseDate.setHours(0, 0, 0, 0);
    const bucket = days.find((d) => d.date.getTime() === purchaseDate.getTime());
    if (bucket) bucket.cents += netCents(purchase.amount_cents);
  }

  const maxCents = Math.max(1, ...days.map((d) => d.cents));

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Sales</h1>
      <p className="mt-1 text-sm text-muted">
        Your net revenue, after Librum&apos;s platform fee.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Net revenue</p>
          <p className="mt-1 font-serif text-2xl font-semibold text-primary">
            ${(totalNetCents / 100).toFixed(2)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Units sold</p>
          <p className="mt-1 font-serif text-2xl font-semibold">
            {totalUnitsSold}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Book page views</p>
          <p className="mt-1 font-serif text-2xl font-semibold">
            {totalViews}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Published books</p>
          <p className="mt-1 font-serif text-2xl font-semibold">
            {publishedCount}
          </p>
        </div>
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        Net revenue, last {CHART_DAYS} days
      </h2>
      <div
        className="mt-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
        style={{ display: "flex", alignItems: "flex-end", height: "8rem", gap: "6px" }}
      >
        {days.map((day) => (
          <div
            key={day.date.toISOString()}
            style={{
              display: "flex",
              flex: "1 1 0%",
              height: "100%",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "4px",
            }}
            title={`${day.date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}: $${(day.cents / 100).toFixed(2)}`}
          >
            <div
              className="w-full rounded-t bg-primary"
              style={{
                height: `${Math.max(2, (day.cents / maxCents) * 100)}%`,
              }}
            />
            <span className="text-[10px] text-muted">
              {day.date.getDate()}
            </span>
          </div>
        ))}
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        By book
      </h2>
      {perBook.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          No books yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {perBook.map((book) => (
            <li
              key={book.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <span className="font-serif font-medium">{book.title}</span>
              <span className="text-sm text-muted">
                {book.views} view{book.views === 1 ? "" : "s"}
              </span>
              <span className="text-sm text-muted">
                {book.unitsSold} sold
              </span>
              <span className="text-sm font-semibold text-primary">
                ${(book.netCents / 100).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
