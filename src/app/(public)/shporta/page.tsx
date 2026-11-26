import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { resolveBookByline } from "@/lib/book-byline";
import { cartCountLabel, cartLineBuyable, cartTotal, lekLabel } from "@/lib/cart";
import { pageErrorMessage } from "@/lib/page-messages";
import { removeFromCart } from "./actions";
import { readCartLines } from "./cart-lines";

// CART (Renato 2026-11-25, item 32; pictures r2 ok): the signed-in
// reader's cart (c2 a). Books for yourself and gifts (g1 a) together.
export const metadata: Metadata = {
  title: "Shporta",
  robots: { index: false },
};

const LINK_BUTTON = "focus-ring inline-flex min-h-11 items-center text-primary underline underline-offset-2";

export default async function CartPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error: rawError } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/shporta");

  const read = await readCartLines(supabase, user.id);
  const lines = read.ok ? read.lines : [];
  const total = cartTotal(lines);
  const anyBuyable = lines.some((l) => cartLineBuyable(l.book));
  const error = pageErrorMessage(rawError);

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <PageHeader title="Shporta" description={lines.length > 0 ? cartCountLabel(lines.length) : undefined} />

      {!read.ok && (
        <Alert variant="error" className="mt-4">
          Shporta nuk u hap. Provoni përsëri pas pak.
        </Alert>
      )}
      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      {read.ok && lines.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="Shporta juaj është bosh."
          description="Librat që shtoni në shportë do të shfaqen këtu."
          action={
            <Link href="/librari" className={buttonClasses("primary", "md")}>
              Shfletoni Librarinë
            </Link>
          }
        />
      ) : (
        lines.length > 0 && (
          <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_20rem] lg:items-start">
            <ul className="divide-y divide-border border-y border-border">
              {lines.map((line) => {
                const book = line.book;
                const buyable = cartLineBuyable(book);
                const coverUrl = book?.cover_path
                  ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
                  : null;
                const byline = book ? resolveBookByline(book) : null;
                return (
                  <li key={line.id} className="flex gap-4 py-5">
                    {coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={coverUrl} alt="" className="h-28 w-[4.5rem] shrink-0 rounded-[3px] object-cover shadow-sm" />
                    ) : (
                      <div aria-hidden="true" className="h-28 w-[4.5rem] shrink-0 rounded-[3px] bg-surface-hover" />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      {book ? (
                        <Link href={`/libra/${book.id}`} className="font-serif text-lg text-foreground underline-offset-2 hover:underline">
                          {book.title}
                        </Link>
                      ) : (
                        <p className="font-serif text-lg text-muted">Libër që nuk është më në Librum</p>
                      )}
                      {byline && <p className="text-sm text-muted">nga {byline}</p>}
                      {line.gift_email && (
                        <div className="mt-1 rounded-[8px] bg-surface-hover px-3 py-2 text-sm">
                          <p className="font-medium break-words">Dhuratë për {line.gift_email}</p>
                          {line.gift_note && <p className="mt-0.5 break-words text-muted">“{line.gift_note}”</p>}
                        </div>
                      )}
                      {!buyable && <p className="text-sm font-medium text-muted">Nuk mund të blihet më.</p>}
                      <div className="mt-auto flex flex-wrap gap-x-4 pt-1 text-sm">
                        {line.gift_email && buyable && (
                          <Link href={`/libra/${line.book_id}/dhurate?item=${line.id}`} className={LINK_BUTTON}>
                            Ndrysho dhuratën
                          </Link>
                        )}
                        <form action={removeFromCart.bind(null, line.id)}>
                          <button type="submit" className={LINK_BUTTON}>
                            Hiqe
                          </button>
                        </form>
                      </div>
                    </div>
                    {buyable && <p className="shrink-0 font-semibold">{lekLabel(book!.price_all as number)}</p>}
                  </li>
                );
              })}
            </ul>
            <aside className="rounded-[12px] border border-border bg-surface p-5">
              <div className="flex items-baseline justify-between">
                <span className="text-muted">Totali</span>
                <span className="text-xl font-semibold">{lekLabel(total)}</span>
              </div>
              {anyBuyable && (
                <Link href="/shporta/pagesa" className={buttonClasses("primary", "lg", "mt-4 w-full")}>
                  Vazhdo te pagesa
                </Link>
              )}
              <Link href="/librari" className="focus-ring mt-2 flex min-h-11 items-center justify-center text-sm text-primary underline underline-offset-2">
                Vazhdo të shfletosh
              </Link>
            </aside>
          </div>
        )
      )}
    </main>
  );
}
