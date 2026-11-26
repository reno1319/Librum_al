import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { resolveBookByline } from "@/lib/book-byline";
import { resolveCatalogPriceState, formatCatalogPriceLabel } from "@/lib/catalog-price";
import { GIFT_NOTE_MAX } from "@/lib/cart";
import { pageErrorMessage } from "@/lib/page-messages";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import { saveGift } from "../../../shporta/actions";

// CART (Renato 2026-11-25, g1 a; pictures r2 ok): the gift form. The
// friend's email and an optional note; the gift goes into the cart.
// With ?item=<cart row> it edits that gift while it is still in the cart.
export const metadata: Metadata = {
  title: "Dhuroje librin",
  robots: { index: false },
};

const FIELD = "focus-ring mt-1 w-full rounded-[8px] border border-[#8c8472] bg-surface px-3 py-2.5 text-base";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function GiftPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ item?: string; error?: string }>;
}) {
  const { id } = await params;
  const { item: rawItem, error: rawError } = await searchParams;
  if (!UUID.test(id)) notFound();
  const itemId = typeof rawItem === "string" && UUID.test(rawItem) ? rawItem : null;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/libra/${id}/dhurate`)}`);

  const { data: book } = await supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .eq("id", id)
    .maybeSingle<PublicBook & { pen: PenNameRef | null }>();
  if (!book) notFound();
  if (book.status !== "published" || resolveCatalogPriceState(book.price_all) !== "paid") redirect(`/libra/${id}`);

  let existing: { gift_email: string | null; gift_note: string | null } | null = null;
  if (itemId) {
    const { data } = await supabase
      .from("cart_items")
      .select("gift_email, gift_note")
      .eq("id", itemId)
      .eq("reader_id", user.id)
      .eq("book_id", id)
      .maybeSingle<{ gift_email: string | null; gift_note: string | null }>();
    if (!data?.gift_email) redirect("/shporta");
    existing = data;
  }

  const error = pageErrorMessage(rawError);
  const coverUrl = book.cover_path ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl : null;
  const byline = resolveBookByline(book);

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <div className="mx-auto max-w-xl">
        <h1 className="font-serif text-2xl text-foreground md:text-4xl">Dhuroje këtë libër</h1>
        {error && (
          <Alert variant="error" className="mt-4">
            {error}
          </Alert>
        )}
        <div className="mt-6 flex gap-4">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="h-28 w-[4.5rem] shrink-0 rounded-[3px] object-cover shadow-sm" />
          ) : (
            <div aria-hidden="true" className="h-28 w-[4.5rem] shrink-0 rounded-[3px] bg-surface-hover" />
          )}
          <div className="min-w-0">
            <p className="font-serif text-lg break-words">{book.title}</p>
            {byline && <p className="text-sm text-muted">nga {byline}</p>}
            <p className="mt-1 font-semibold">{formatCatalogPriceLabel(book.price_all)}</p>
          </div>
        </div>
        <form action={saveGift.bind(null, id, itemId)} className="mt-8 flex flex-col gap-5">
          <label htmlFor="gift-email" className="block text-sm font-medium">
            Emaili i personit që e merr
            <input
              id="gift-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              defaultValue={existing?.gift_email ?? ""}
              className={FIELD}
            />
            <span className="mt-1 block font-normal text-muted">I dërgojmë një email me lidhjen për ta marrë librin.</span>
          </label>
          <label htmlFor="gift-note" className="block text-sm font-medium">
            Shënim (nuk është i detyrueshëm)
            <textarea
              id="gift-note"
              name="note"
              rows={3}
              maxLength={GIFT_NOTE_MAX}
              defaultValue={existing?.gift_note ?? ""}
              className={FIELD}
            />
          </label>
          <button type="submit" className={buttonClasses("primary", "lg", "w-full")}>
            {itemId ? "Ruaj dhuratën" : "Shtoje dhuratën në shportë"}
          </button>
          <Link
            href={itemId ? "/shporta" : `/libra/${id}`}
            className="focus-ring flex min-h-11 items-center justify-center text-sm text-primary underline underline-offset-2"
          >
            Anulo
          </Link>
        </form>
      </div>
    </main>
  );
}
