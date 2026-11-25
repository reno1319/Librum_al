import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { CARD_PAYMENT_SOON_LINE, PAY_PRESSED_LINE, cartLineBuyable, cartTotal, lekLabel } from "@/lib/cart";
import { pressPay } from "../actions";
import { readCartLines } from "../cart-lines";

// CART (Renato 2026-11-25, c1 a): the last step. Card payment is not
// open yet, so Pay charges nothing: after pressing it the reader sees
// the "opens soon" message and the cart stays saved.
export const metadata: Metadata = {
  title: "Pagesa",
  robots: { index: false },
};

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<{ paguaj?: string }> }) {
  const { paguaj } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?next=/shporta/pagesa");

  const read = await readCartLines(supabase, user.id);
  if (!read.ok) redirect(`/shporta?error=${encodeURIComponent("Shporta nuk u hap. Provoni përsëri pas pak.")}`);
  const lines = read.lines.filter((l) => cartLineBuyable(l.book));
  if (lines.length === 0) redirect("/shporta");
  const total = cartTotal(lines);

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <PageHeader title="Pagesa" />
      {paguaj === "se-shpejti" && (
        <Alert variant="info" className="mt-6">
          <strong>{CARD_PAYMENT_SOON_LINE}</strong> {PAY_PRESSED_LINE}
        </Alert>
      )}
      <div className="mt-6 max-w-xl rounded-[12px] border border-border bg-surface p-5">
        <h2 className="font-semibold">Porosia juaj</h2>
        <ul className="mt-3 divide-y divide-border text-sm">
          {lines.map((line) => (
            <li key={line.id} className="flex justify-between gap-4 py-2.5">
              <span className="min-w-0 break-words">
                {line.book!.title}
                {line.gift_email && <span className="text-muted"> · dhuratë për {line.gift_email}</span>}
              </span>
              <span className="shrink-0">{lekLabel(line.book!.price_all as number)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex items-baseline justify-between border-t border-border pt-3">
          <span className="font-semibold">Totali</span>
          <span className="text-xl font-semibold">{lekLabel(total)}</span>
        </div>
        <form action={pressPay}>
          <button type="submit" className={buttonClasses("primary", "lg", "mt-4 w-full")}>
            Paguaj {lekLabel(total)}
          </button>
        </form>
        <Link href="/shporta" className="focus-ring mt-2 flex min-h-11 items-center justify-center text-sm text-primary underline underline-offset-2">
          Kthehu te shporta
        </Link>
      </div>
    </main>
  );
}
