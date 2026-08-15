"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";
import { platformFeeCents } from "@/lib/pricing";

type BookForCheckout = {
  id: string;
  title: string;
  price_cents: number;
  status: string;
  author_id: string;
  profiles: {
    stripe_account_id: string | null;
    stripe_payouts_enabled: boolean;
  } | null;
};

export async function buyBook(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/books/${bookId}`);
  }

  const { data: book } = await supabase
    .from("books")
    .select(
      "id, title, price_cents, status, author_id, profiles(stripe_account_id, stripe_payouts_enabled)",
    )
    .eq("id", bookId)
    .single<BookForCheckout>();

  if (!book || book.status !== "published" || book.author_id === user.id) {
    redirect(`/books/${bookId}`);
  }

  const authorAccount = book.profiles?.stripe_account_id;
  if (!book.profiles?.stripe_payouts_enabled || !authorAccount) {
    redirect(`/books/${bookId}?error=This+book+isn%27t+available+for+purchase+right+now`);
  }

  const { data: existing } = await supabase
    .from("purchases")
    .select("id")
    .eq("book_id", bookId)
    .eq("reader_id", user.id)
    .maybeSingle();

  if (existing) {
    redirect(`/books/${bookId}`);
  }

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: book.title },
          unit_amount: book.price_cents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFeeCents(book.price_cents),
      transfer_data: {
        destination: authorAccount,
      },
    },
    success_url: `${origin}/books/${bookId}?purchase=success`,
    cancel_url: `${origin}/books/${bookId}?purchase=cancelled`,
    metadata: {
      book_id: bookId,
      reader_id: user.id,
    },
  });

  if (!session.url) {
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  redirect(session.url);
}

export async function submitReview(bookId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/books/${bookId}`);
  }

  const rating = Number(formData.get("rating"));
  const body = String(formData.get("body") ?? "").trim();

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    redirect(`/books/${bookId}?error=Please+choose+a+rating`);
  }

  const { data: purchase } = await supabase
    .from("purchases")
    .select("id")
    .eq("book_id", bookId)
    .eq("reader_id", user.id)
    .maybeSingle();

  if (!purchase) {
    redirect(`/books/${bookId}?error=Buy+this+book+to+review+it`);
  }

  // Resubmitting overwrites the reader's existing review for this book,
  // thanks to the unique(book_id, reader_id) constraint — no separate
  // "edit" flow needed.
  const { error } = await supabase
    .from("reviews")
    .upsert(
      { book_id: bookId, reader_id: user.id, rating, body },
      { onConflict: "book_id,reader_id" },
    );

  if (error) {
    redirect(`/books/${bookId}?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/books/${bookId}?review=success`);
}
