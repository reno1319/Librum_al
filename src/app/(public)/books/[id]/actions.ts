"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { AUTHOR_ROYALTY_RATE_BPS } from "@/lib/pricing";
import { REPORT_REASONS } from "@/lib/report-reasons";
import { resolveSiteOrigin } from "@/lib/site-url";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { BOOK_CHECKOUT_UNAVAILABLE_MESSAGE } from "@/lib/connect-account";
import { resolveActiveCheckoutProvider } from "@/lib/checkout-regime";
import { createPokClient, getPokConfig, type PokConfig } from "@/lib/pok";
import {
  startPokCheckout,
  POK_CHECKOUT_CANNOT_RESUME,
  POK_CHECKOUT_MAINTENANCE_ACTIVE,
} from "@/lib/pok-checkout";
import { createPokRepository } from "@/lib/pok-repository";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import type { DiscountCode } from "@/lib/types";

type BookForCheckout = {
  id: string;
  title: string;
  price_cents: number;
  status: string;
  author_id: string;
};

// The shape create_book_checkout_intent (migration 032) returns.
type CheckoutIntentResult = {
  intent_id: string;
  price_cents_at_checkout: number;
  discount_code_id: string | null;
  expires_at: string;
};

export async function buyBook(bookId: string, formData: FormData) {
  // ALL-CUTOVER APP-A: the maintenance gate is the very first statement
  // in this function -- before redirectIfRecoverySessionActive(), before
  // any Supabase client construction, and before any POK call. No
  // checkout intent, provider order, or purchase row may be created
  // while the cutover's maintenance window is active.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/books/${bookId}`);
  }

  // LAUNCH-1 P1-11: defense-in-depth -- Proxy already blocks the
  // /books/[id] page itself while a recovery session is active, so this
  // is the second layer against a crafted direct POST. Runs before any
  // Stripe/Supabase call below.
  await redirectIfRecoverySessionActive();

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

  // STRIPE-DISABLE-1: the ONLY point that decides whether this checkout
  // may proceed at all, and with which provider -- server-only, never
  // overridable by request input, and evaluated through the single
  // shared resolution policy (src/lib/checkout-regime.ts) rather than a
  // parallel ad hoc comparison. Every configuration other than the exact
  // pair NEW_CHECKOUT_REGIME=librum_ledger_v1 /
  // LEDGER_PAYMENT_PROVIDER=pok -- missing, empty, malformed,
  // wrong-cased, the pre-cutover legacy default included -- fails closed
  // HERE, before any RPC, POK, or Stripe call, and before any
  // checkout-intent or other DB state is created. This intentionally
  // removes the legacy Stripe Connect checkout path entirely: no new
  // Stripe buyer checkout may be created by this action any more, only
  // an exact-config POK checkout.
  const activeProvider = resolveActiveCheckoutProvider({
    newCheckoutRegime: process.env.NEW_CHECKOUT_REGIME,
    ledgerPaymentProvider: process.env.LEDGER_PAYMENT_PROVIDER,
  });

  if (activeProvider !== "pok") {
    redirect(`/books/${bookId}?error=${encodeURIComponent(BOOK_CHECKOUT_UNAVAILABLE_MESSAGE)}`);
  }

  let pokConfig: PokConfig;
  try {
    pokConfig = getPokConfig();
  } catch {
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  // Cheap, non-authoritative early check for a friendlier redirect --
  // create_book_checkout_intent re-validates ownership atomically at the
  // moment it actually mints/reuses the checkout intent (see LAUNCH-1
  // P1-4), so nothing here needs to be race-free with that. LAUNCH-1
  // P1-7A: routed through user_owns_book() (also excludes a purchase
  // whose payment intent has a dispute at status 'lost') rather than a
  // raw purchases select, so this early check agrees with the RPC's own
  // now-corrected authoritative check -- a reader whose only purchase
  // was disputed-and-lost is no longer redirected away as "already
  // owns it."
  const { data: ownsBook } = await supabase.rpc("user_owns_book", {
    target_book_id: bookId,
  });

  if (ownsBook) {
    redirect(`/books/${bookId}`);
  }

  // Cheap, non-authoritative early check purely for a friendlier "That
  // promo code isn't valid" message -- create_book_checkout_intent
  // independently re-normalizes and re-validates the code itself, never
  // trusting this check's result, exactly the two-layer pattern
  // buyBundle already uses for its own early ownership check alongside
  // create_bundle_checkout_snapshot's own authoritative one.
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
  }

  // The sole source of truth for what Stripe actually charges from this
  // point forward -- price, the resolved discount, and this attempt's
  // own durable identity are all frozen atomically by this one call
  // (migration 032's create_book_checkout_intent, evolved by migration
  // 056). Never trusts book.price_cents or the discount lookup above for
  // the actual charge -- both are re-derived server-side inside the RPC,
  // which is directly callable by any authenticated client and so can
  // never trust a caller-supplied price.
  //
  // STRIPE-DISABLE-1: `activeProvider === "pok"` above already proves the
  // regime is exactly librum_ledger_v1 (see resolveActiveCheckoutProvider) --
  // the legacy-regime branch that used to omit these trailing params is
  // unreachable here now, since a legacy-regime checkout can never reach
  // this line any more. Currency and royalty_rate_bps are frozen HERE, on
  // this exact call -- ALL (no FX) and AUTHOR_ROYALTY_RATE_BPS (the
  // current platform rate snapshotted ONCE, never recomputed later at
  // webhook/finalization time).
  const { data: intentRows, error: intentError } = await supabase.rpc(
    "create_book_checkout_intent",
    {
      book_id: bookId,
      p_discount_code: rawCode || null,
      p_regime: "librum_ledger_v1",
      p_currency: "ALL",
      p_royalty_rate_bps: AUTHOR_ROYALTY_RATE_BPS,
    },
  );

  const intent = (intentRows as CheckoutIntentResult[] | null)?.[0];

  if (intentError || !intent) {
    console.error("buyBook: create_book_checkout_intent failed", {
      bookId,
      readerId: user.id,
      error: intentError,
    });
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  // `intentRows as CheckoutIntentResult[] | null` above is a
  // compile-time cast only -- it gives no runtime guarantee the RPC
  // actually returned well-formed values. Every field that flows into
  // the Stripe call below is checked explicitly before that call is
  // ever made.
  const isIntentUsable =
    typeof intent.intent_id === "string" &&
    intent.intent_id.length > 0 &&
    typeof intent.price_cents_at_checkout === "number" &&
    Number.isInteger(intent.price_cents_at_checkout) &&
    intent.price_cents_at_checkout > 0 &&
    Number.isFinite(Date.parse(intent.expires_at));

  if (!isIntentUsable) {
    console.error("buyBook: checkout intent RPC returned a malformed result", {
      bookId,
      readerId: user.id,
      intent,
    });
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  const origin = resolveSiteOrigin();

  // STRIPE-DISABLE-1: POK is the only enabled paid-book route now -- the
  // Stripe Checkout Session creation call site that used to follow here
  // for every other configuration has been removed entirely, not merely
  // made unreachable, per the locked product decision. `activeProvider
  // === "pok"` (checked above, before any RPC call) is this function's
  // only path past this point.
  let checkoutUrl: string;
  try {
    checkoutUrl = await startPokCheckout({
      intentId: intent.intent_id, readerId: user.id, title: book.title,
      origin, merchantId: pokConfig.merchantId,
    }, createPokRepository(), createPokClient(pokConfig));
  } catch (err) {
    // ALL-CUTOVER APP-A: startPokCheckout()'s own defense-in-depth
    // maintenance gate fired -- map it back to the exact same
    // deterministic redirect this function's own top-of-function gate
    // already produces, so the reader-visible outcome never depends on
    // which of the two layers actually caught the maintenance window.
    if (err instanceof Error && err.message === POK_CHECKOUT_MAINTENANCE_ACTIVE) {
      redirectForMaintenance(`/books/${bookId}`);
    }
    // A stale checkout can never be silently resumed (see pok-checkout's
    // assertReusableUnpaidOrder) -- tell the reader that plainly instead
    // of implying a retry will work, since it won't: this same intent's
    // mapping row is already claimed and reusing it is exactly what just
    // failed. Every other failure keeps the existing generic message.
    if (err instanceof Error && err.message === POK_CHECKOUT_CANNOT_RESUME) {
      redirect(
        `/books/${bookId}?error=${encodeURIComponent(
          "We can't safely reopen this checkout. If you already paid, check your library; otherwise, please contact support to complete this purchase.",
        )}`,
      );
    }
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }
  redirect(checkoutUrl);
}

type BookForFreeAcquisition = {
  id: string;
  price_cents: number;
  status: string;
  author_id: string;
};

export async function getFreeBook(bookId: string) {
  // ALL-CUTOVER APP-A: free acquisition still writes a purchases row
  // (amount_cents: 0) -- a column the cutover renames/retypes -- so it
  // is gated identically to every paid checkout path, before any
  // Supabase client construction.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/books/${bookId}`);
  }

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

  // LAUNCH-1 P1-7A: routed through user_owns_book() (also excludes a
  // purchase whose payment intent has a dispute at status 'lost')
  // rather than a raw purchases select -- a reader whose only purchase
  // was disputed-and-lost is no longer treated as "already owned" here,
  // and instead correctly falls through to a fresh acquisition below
  // (the same upsert-over-the-old-row path a refunded reader already
  // takes to legitimately reacquire a book).
  const { data: ownsBook } = await supabase.rpc("user_owns_book", {
    target_book_id: bookId,
  });

  if (ownsBook) {
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

  // LAUNCH-1 P1-7A: routed through user_owns_book() (also excludes a
  // purchase whose payment intent has a dispute at status 'lost', see
  // migration 035) rather than a raw purchases select -- public.
  // payment_disputes is fully closed to this request-scoped client, and
  // this SECURITY DEFINER RPC already encapsulates the complete,
  // correct ownership predicate.
  const { data: ownsBook } = await supabase.rpc("user_owns_book", {
    target_book_id: bookId,
  });

  if (!ownsBook) {
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
    // LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: was error.message -- the raw
    // Postgres/PostgREST error passed straight through to the URL and
    // rendered verbatim (e.g. an RLS rejection or constraint violation
    // in developer-facing English). Every OTHER redirect in this
    // function uses a Librum-authored string; this is the one that
    // didn't.
    redirect(
      `/books/${bookId}?error=${encodeURIComponent("We couldn't save your review. Please try again.")}`,
    );
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
    // LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: same correction as the review
    // upsert above -- was error.message.
    redirect(
      `/books/${bookId}/report?error=${encodeURIComponent("We couldn't submit your report. Please try again.")}`,
    );
  }

  redirect(`/books/${bookId}?report=success`);
}
