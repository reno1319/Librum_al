"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { stripe } from "@/lib/stripe";
import { platformFeeCents, applyDiscount } from "@/lib/pricing";
import { REPORT_REASONS } from "@/lib/report-reasons";
import type { DiscountCode } from "@/lib/types";

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

export async function buyBook(bookId: string, formData: FormData) {
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

  // Free books must go through getFreeBook, never Stripe -- this is a
  // server-side invariant, not just a UI convenience: the price is
  // re-read from the database here, so this holds even if buyBook were
  // ever invoked directly for a book priced at 0.
  if (book.price_cents <= 0) {
    redirect(`/books/${bookId}?error=This+book+is+free+-+use+the+free+download+option+instead`);
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
    .is("refunded_at", null)
    .maybeSingle();

  if (existing) {
    redirect(`/books/${bookId}`);
  }

  let priceCents = book.price_cents;
  let discountCodeId: string | null = null;

  const rawCode = String(formData.get("code") ?? "").trim().toUpperCase();
  if (rawCode) {
    // Codes aren't publicly listable (see the RLS policies in
    // schema.sql) — this is the one place one gets looked up, done
    // server-side with the service role key against this specific book.
    const admin = createAdminClient();
    const { data: discount } = await admin
      .from("discount_codes")
      .select("*")
      .eq("book_id", bookId)
      .eq("code", rawCode)
      .eq("active", true)
      .maybeSingle<DiscountCode>();

    const isExpired =
      !!discount?.expires_at && new Date(discount.expires_at) < new Date();

    if (!discount || isExpired) {
      redirect(`/books/${bookId}?error=That+promo+code+isn%27t+valid`);
    }

    priceCents = applyDiscount(book.price_cents, discount);
    discountCodeId = discount.id;
  }

  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: book.title },
          unit_amount: priceCents,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFeeCents(priceCents),
      transfer_data: {
        destination: authorAccount,
      },
    },
    success_url: `${origin}/books/${bookId}?purchase=success`,
    cancel_url: `${origin}/books/${bookId}?purchase=cancelled`,
    metadata: {
      book_id: bookId,
      reader_id: user.id,
      ...(discountCodeId ? { discount_code_id: discountCodeId } : {}),
    },
  });

  if (!session.url) {
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  redirect(session.url);
}

type BookForFreeAcquisition = {
  id: string;
  price_cents: number;
  status: string;
  author_id: string;
};

export async function getFreeBook(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/books/${bookId}`);
  }

  const { data: book } = await supabase
    .from("books")
    .select("id, price_cents, status, author_id")
    .eq("id", bookId)
    .single<BookForFreeAcquisition>();

  if (
    !book ||
    book.status !== "published" ||
    book.price_cents !== 0 ||
    book.author_id === user.id
  ) {
    redirect(`/books/${bookId}`);
  }

  const { data: existing } = await supabase
    .from("purchases")
    .select("id")
    .eq("book_id", bookId)
    .eq("reader_id", user.id)
    .is("refunded_at", null)
    .maybeSingle();

  if (existing) {
    // Already owned (e.g. a real paid purchase from before the book went
    // free) -- idempotent no-op rather than overwriting that record.
    redirect(`/books/${bookId}?free=success`);
  }

  // Free acquisitions never touch Stripe, so there's no real checkout
  // session id to store. purchases.stripe_checkout_session_id is
  // not-null, and this column is never read back anywhere (only written,
  // in this file and the Stripe webhook) -- so a clearly-non-Stripe
  // placeholder satisfies the constraint without a schema change or any
  // risk of being mistaken for a real payment.
  const admin = createAdminClient();
  const { error } = await admin.from("purchases").upsert(
    {
      book_id: bookId,
      reader_id: user.id,
      amount_cents: 0,
      stripe_checkout_session_id: `free_${randomUUID()}`,
      stripe_payment_intent_id: null,
      refunded_at: null,
    },
    { onConflict: "book_id,reader_id" },
  );

  if (error) {
    redirect(`/books/${bookId}?error=Could+not+add+this+book+right+now`);
  }

  revalidatePath(`/books/${bookId}`);
  revalidatePath("/library");

  redirect(`/books/${bookId}?free=success`);
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
    .is("refunded_at", null)
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

export async function addToWishlist(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/books/${bookId}`);
  }

  await supabase.from("wishlist_items").insert({
    book_id: bookId,
    reader_id: user.id,
  });

  revalidatePath(`/books/${bookId}`);
  revalidatePath("/wishlist");
}

export async function removeFromWishlist(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("wishlist_items")
    .delete()
    .eq("book_id", bookId)
    .eq("reader_id", user.id);

  revalidatePath(`/books/${bookId}`);
  revalidatePath("/wishlist");
}

export async function submitReport(bookId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/books/${bookId}/report`);
  }

  const reason = String(formData.get("reason") ?? "");
  const details = String(formData.get("details") ?? "").trim();

  if (!REPORT_REASONS.includes(reason as (typeof REPORT_REASONS)[number])) {
    redirect(`/books/${bookId}/report?error=Please+choose+a+reason`);
  }

  const { error } = await supabase.from("book_reports").insert({
    book_id: bookId,
    reporter_id: user.id,
    reason,
    details,
  });

  if (error) {
    redirect(`/books/${bookId}/report?error=${encodeURIComponent(error.message)}`);
  }

  redirect(`/books/${bookId}?report=success`);
}
