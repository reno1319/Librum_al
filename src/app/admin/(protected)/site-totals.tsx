import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";

// G4 batch 3 (Renato g4q9 a, g4q10 a / g4q10b a, b3e3 a): four all-time
// numbers on Today, for Owner and Admin only (the page renders this
// only for people.view + finance.view, which only they hold). Counts
// only, never an amount:
// - Live books: books with status "published" (the Books page's Live filter).
// - Authors / Readers: accounts, the same totals the People page shows
//   (admin_list_people checks people.view itself).
// - Sales: paid purchases not refunded, the People page's Sales rule.
// A failed read shows "—" for that number only.
export const SITE_TOTALS_NOTE = "Since the start. Authors and readers are accounts; sales are purchases, no amounts.";

export function formatSiteTotal(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("en-US");
}

async function peopleTotal(kind: "authors" | "readers"): Promise<number | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_people", { p_kind: kind, p_limit: 1 });
  if (error) {
    console.error("site totals: people read failed", { kind, code: error.code ?? null });
    return null;
  }
  const first = Array.isArray(data) ? (data[0] as { total_count?: unknown } | undefined) : undefined;
  // No row at all means no account of that kind.
  return first ? Number(first.total_count ?? 0) : 0;
}

export async function loadSiteTotals(): Promise<{
  liveBooks: number | null;
  authors: number | null;
  readers: number | null;
  sales: number | null;
}> {
  // Service-role reads: this file checks the two permissions itself as
  // well as the page, so it can never be reached by anyone else.
  await requireStaff("people.view");
  await requireStaff("finance.view");
  const admin = createAdminClient();
  const [books, authors, readers, sales] = await Promise.all([
    admin.from("books").select("id", { count: "exact", head: true }).eq("status", "published"),
    peopleTotal("authors"),
    peopleTotal("readers"),
    admin
      .from("purchases")
      .select("id", { count: "exact", head: true })
      .gt("amount_cents", 0)
      .is("refunded_at", null),
  ]);
  if (books.error) console.error("site totals: books read failed", { code: books.error.code ?? null });
  if (sales.error) console.error("site totals: sales read failed", { code: sales.error.code ?? null });
  return {
    liveBooks: books.error ? null : (books.count ?? 0),
    authors,
    readers,
    sales: sales.error ? null : (sales.count ?? 0),
  };
}

export async function SiteTotals() {
  const totals = await loadSiteTotals();
  const items: [string, number | null][] = [
    ["Live books", totals.liveBooks],
    ["Authors", totals.authors],
    ["Readers", totals.readers],
    ["Sales", totals.sales],
  ];
  return (
    <section aria-labelledby="today-totals" className="rounded-card border border-border bg-surface px-4 py-3.5 md:px-6">
      <h2 id="today-totals" className="text-xs font-semibold tracking-[0.12em] text-[#806510] uppercase">
        Site totals
      </h2>
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
        {items.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-[0.8125rem] text-muted">{label}</dt>
            <dd className="font-serif text-[1.375rem] font-bold text-primary tabular-nums">{formatSiteTotal(value)}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-1.5 text-[0.8125rem] text-muted">{SITE_TOTALS_NOTE}</p>
    </section>
  );
}
