"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { stripe } from "@/lib/stripe";

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
    .select("id, title, price_cents, status, author_id")
    .eq("id", bookId)
    .single();

  if (!book || book.status !== "published" || book.author_id === user.id) {
    redirect(`/books/${bookId}`);
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
