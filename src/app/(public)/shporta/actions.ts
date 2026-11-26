"use server";

// CART (Renato 2026-11-25, item 32): the cart's server actions. Every
// write goes through the reader's own session, so the row rules of
// public.cart_items (migration 20261125130000_cart_items.sql) decide;
// the checks here only turn a refusal into a clear message.

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveCatalogPriceState } from "@/lib/catalog-price";
import { CART_MAX_ITEMS, readGiftInput } from "@/lib/cart";

type Supabase = Awaited<ReturnType<typeof createClient>>;

async function signedInUser(next: string) {
  await redirectIfRecoverySessionActive();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return { supabase, user };
}

// The add rule, read first so the reader gets a reason, not a database
// error: live, paid, not the reader's own book (g4 a).
async function bookRefusal(supabase: Supabase, bookId: string, userId: string): Promise<"unavailable" | "own" | null> {
  const { data: book } = await supabase
    .from("public_books")
    .select("id, status, price_all")
    .eq("id", bookId)
    .maybeSingle<{ id: string; status: string; price_all: number | null }>();
  if (!book || book.status !== "published" || resolveCatalogPriceState(book.price_all) !== "paid") {
    return "unavailable";
  }
  const { data: own } = await supabase.from("books").select("id").eq("id", bookId).eq("author_id", userId).maybeSingle();
  if (own) return "own";
  return null;
}

async function cartIsFull(supabase: Supabase, userId: string): Promise<boolean> {
  const { count } = await supabase
    .from("cart_items")
    .select("id", { count: "exact", head: true })
    .eq("reader_id", userId);
  return (count ?? 0) >= CART_MAX_ITEMS;
}

function refuseBook(bookId: string, refusal: "unavailable" | "own"): never {
  if (refusal === "own") {
    redirect(`/libra/${bookId}?error=${encodeURIComponent("Nuk mund ta blini ose ta dhuroni librin tuaj.")}`);
  }
  redirect(`/libra/${bookId}?error=${encodeURIComponent("Ky libër nuk mund të shtohet në shportë.")}`);
}

function cartFull(bookId: string): never {
  redirect(`/libra/${bookId}?error=${encodeURIComponent("Shporta mban deri në 50 libra.")}`);
}

function addFailed(bookId: string): never {
  redirect(`/libra/${bookId}?error=${encodeURIComponent("Nuk u shtua në shportë. Provoni përsëri.")}`);
}

export async function addToCart(bookId: string) {
  await addToCartThen(bookId, `/libra/${bookId}`, "/shporta");
}

// LR1 (Renato 11-25, lr1-4 a): "Shto" on a Libraria card adds the book
// and keeps the reader on Libraria; the card then reads "Në shportë".
// Same rules and refusals as the book page's button (a refusal still
// opens the book page with its reason). No redirect: the page re-renders
// in place, so the reader keeps their scroll position.
export async function addToCartFromLibraria(bookId: string) {
  await addToCartThen(bookId, "/librari", null);
}

async function addToCartThen(bookId: string, loginNext: string, done: string | null) {
  const { supabase, user } = await signedInUser(loginNext);

  const refusal = await bookRefusal(supabase, bookId, user.id);
  if (refusal) refuseBook(bookId, refusal);

  const { data: owned } = await supabase.rpc("user_owns_book", { target_book_id: bookId });
  if (owned) redirect(`/libra/${bookId}?error=${encodeURIComponent("Këtë libër e keni tashmë në Bibliotekë.")}`);

  const { data: existing } = await supabase
    .from("cart_items")
    .select("id")
    .eq("reader_id", user.id)
    .eq("book_id", bookId)
    .is("gift_email", null)
    .maybeSingle();

  if (!existing) {
    if (await cartIsFull(supabase, user.id)) cartFull(bookId);
    const { error } = await supabase.from("cart_items").insert({ reader_id: user.id, book_id: bookId });
    // 23505: added a moment ago in another tab; the book is in the cart.
    if (error && error.code !== "23505") addFailed(bookId);
  }

  revalidatePath("/", "layout");
  if (done) redirect(done);
}

// g1 a: a gift is a cart row with the friend's email and an optional
// note. With an item id it edits that gift (g2 a, while still in the
// cart).
export async function saveGift(bookId: string, itemId: string | null, formData: FormData) {
  const formPath = itemId ? `/libra/${bookId}/dhurate?item=${itemId}&` : `/libra/${bookId}/dhurate?`;
  const { supabase, user } = await signedInUser(`/libra/${bookId}/dhurate`);

  const input = readGiftInput(formData.get("email"), formData.get("note"));
  if (!input.ok) {
    if (input.error === "note") {
      redirect(`${formPath}error=${encodeURIComponent("Shënimi mund të ketë deri në 300 shkronja.")}`);
    }
    redirect(`${formPath}error=${encodeURIComponent("Shkruani një email të saktë për personin që e merr.")}`);
  }

  const refusal = await bookRefusal(supabase, bookId, user.id);
  if (refusal) refuseBook(bookId, refusal);

  if (itemId) {
    const { data, error } = await supabase
      .from("cart_items")
      .update({ gift_email: input.value.email, gift_note: input.value.note })
      .eq("id", itemId)
      .eq("reader_id", user.id)
      .eq("book_id", bookId)
      .not("gift_email", "is", null)
      .select("id");
    if (error?.code === "23505") {
      redirect(`${formPath}error=${encodeURIComponent("Ky libër është tashmë në shportë si dhuratë për këtë email.")}`);
    }
    if (error || !data || data.length === 0) {
      redirect(`/shporta?error=${encodeURIComponent("Dhurata nuk u ndryshua. Provoni përsëri.")}`);
    }
  } else {
    if (await cartIsFull(supabase, user.id)) cartFull(bookId);
    const { error } = await supabase.from("cart_items").insert({
      reader_id: user.id,
      book_id: bookId,
      gift_email: input.value.email,
      gift_note: input.value.note,
    });
    if (error?.code === "23505") {
      redirect(`${formPath}error=${encodeURIComponent("Ky libër është tashmë në shportë si dhuratë për këtë email.")}`);
    }
    if (error) addFailed(bookId);
  }

  revalidatePath("/", "layout");
  redirect("/shporta");
}

export async function removeFromCart(itemId: string) {
  const { supabase, user } = await signedInUser("/shporta");
  await supabase.from("cart_items").delete().eq("id", itemId).eq("reader_id", user.id);
  revalidatePath("/", "layout");
  redirect("/shporta");
}

// c1 a: card payment is not open yet. Pressing Pay charges nothing and
// creates nothing; the reader comes back to the last step with the
// message, and the cart stays as it is.
export async function pressPay() {
  await signedInUser("/shporta/pagesa");
  redirect("/shporta/pagesa?paguaj=se-shpejti");
}
