"use server";

import Stripe from "stripe";
import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe";
import { AUTHOR_ROYALTY_RATE_BPS } from "@/lib/pricing";
import { REPORT_REASONS } from "@/lib/report-reasons";
import {
  toStripeExpiresAtSeconds,
  buildLegacyBookCheckoutSessionParams,
  buildLedgerBookCheckoutSessionParams,
} from "./checkout-logic";
import { resolveSiteOrigin } from "@/lib/site-url";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import {
  checkConnectedAccountReadyForCheckout,
  BOOK_CHECKOUT_UNAVAILABLE_MESSAGE,
} from "@/lib/connect-account";
import { resolveCheckoutRegime, isStripeSecretKeyTestMode } from "@/lib/checkout-regime";
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

// The shape create_book_checkout_intent (migration 032) returns.
type CheckoutIntentResult = {
  intent_id: string;
  price_cents_at_checkout: number;
  discount_code_id: string | null;
  expires_at: string;
};

export async function buyBook(bookId: string, formData: FormData) {
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

  // STRIPE-CUTOVER-2A Section 3: the ONLY point that decides this
  // checkout's regime -- server-only, never overridable by request
  // input. Once create_book_checkout_intent below actually mints a
  // fresh row, ITS OWN frozen regime column (migration 056) is
  // authoritative forever, independent of whatever this env var says on
  // any later request.
  const regime = resolveCheckoutRegime(process.env.NEW_CHECKOUT_REGIME);

  // legacy_stripe_connect_v1 has a Stripe Connect account dependency;
  // librum_ledger_v1 (TEST-mode only, Section 6/7) deliberately does
  // not -- it never sends transfer_data.destination/application_fee_amount,
  // so requiring the author to have a working Connect account here would
  // needlessly block exactly the authors ledger_v1 exists to eventually
  // serve. authorAccount therefore only needs to be resolved, and only
  // needs to be READY, on the legacy path.
  let authorAccount: string | null = null;

  if (regime === "legacy_stripe_connect_v1") {
    authorAccount = book.profiles?.stripe_account_id ?? null;
    if (!authorAccount) {
      redirect(`/books/${bookId}?error=${encodeURIComponent(BOOK_CHECKOUT_UNAVAILABLE_MESSAGE)}`);
    }

    // LIBRUM 2.0 CONNECT-HARDEN-1: never trust profiles.stripe_payouts_enabled
    // alone -- it's a webhook-synchronized cache (see
    // processAccountUpdatedEvent in the Stripe webhook route), not a live
    // guarantee. A stored account id that's stale, wrong-platform, or
    // wrong-mode must be caught HERE, before any checkout intent is minted
    // or Stripe is ever asked to use it as a transfer destination -- this
    // is the direct fix for the production incident where Stripe rejected
    // checkout with "No such destination" for exactly this reason. The
    // real Stripe/DB reason is logged server-side only; the reader only
    // ever sees the same generic, pre-existing unavailability message.
    const accountCheck = await checkConnectedAccountReadyForCheckout(getStripe(), authorAccount);
    if (!accountCheck.ok) {
      console.error("buyBook: author's connected Stripe account is not ready for checkout", {
        bookId,
        authorId: book.author_id,
        readerId: user.id,
        reason: accountCheck.reason,
        detail: accountCheck.detail,
      });
      redirect(`/books/${bookId}?error=${encodeURIComponent(BOOK_CHECKOUT_UNAVAILABLE_MESSAGE)}`);
    }
  } else {
    // STRIPE-CUTOVER-2A Section 4: TEST-mode safety -- ledger_v1 must
    // never silently create real commerce. The smallest robust,
    // non-client-trusting proof available at THIS stage is the
    // platform's own configured Stripe secret key. Fails closed (the
    // same generic, no-internal-detail message every other checkout
    // failure in this function already uses) rather than proceeding on
    // an unverifiable assumption.
    if (!isStripeSecretKeyTestMode(process.env.STRIPE_SECRET_KEY)) {
      console.error(
        "buyBook: refusing to create a librum_ledger_v1 checkout -- Stripe is not configured in test mode",
        { bookId, readerId: user.id },
      );
      redirect(`/books/${bookId}?error=Could+not+start+checkout`);
    }
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
  // STRIPE-CUTOVER-2A Section 5: for regime=librum_ledger_v1, currency
  // and royalty_rate_bps are frozen HERE, on this exact call -- ALL
  // (Section 8, no FX) and AUTHOR_ROYALTY_RATE_BPS (Section 22, the
  // current platform rate snapshotted ONCE, never recomputed later at
  // webhook/finalization time). For the legacy default these three
  // trailing params are omitted entirely -- create_book_checkout_intent
  // takes their DB-side defaults (legacy_stripe_connect_v1/USD/null),
  // identical to this call's pre-2A shape, so legacy checkout economics
  // are unchanged.
  const { data: intentRows, error: intentError } = await supabase.rpc(
    "create_book_checkout_intent",
    regime === "librum_ledger_v1"
      ? {
          book_id: bookId,
          p_discount_code: rawCode || null,
          p_regime: "librum_ledger_v1",
          p_currency: "ALL",
          p_royalty_rate_bps: AUTHOR_ROYALTY_RATE_BPS,
        }
      : { book_id: bookId, p_discount_code: rawCode || null },
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

  // Aligned with the intent's own expires_at (Math.floor, never
  // Math.round -- see toStripeExpiresAtSeconds) so Stripe can never hold
  // this session payable past the moment the database has already
  // stopped reusing this intent for a fresh attempt. Shared by both
  // regimes -- this expiry mechanism has nothing to do with payment
  // economics.
  const expiresAtSeconds = toStripeExpiresAtSeconds(intent.expires_at);

  // STRIPE-CUTOVER-2A Section 6/7: the legacy branch's params are
  // byte-identical to the pre-2A inline object (now built by
  // buildLegacyBookCheckoutSessionParams) -- Connect destination
  // transfer and application fee, USD. The ledger branch
  // (buildLedgerBookCheckoutSessionParams) has neither -- no
  // transfer_data.destination, no application_fee_amount, currency
  // "all", amount used directly as internal minor units. `authorAccount`
  // is guaranteed non-null here whenever regime is legacy (redirected
  // above otherwise); the ledger branch never reads it at all.
  const sessionParams =
    regime === "librum_ledger_v1"
      ? buildLedgerBookCheckoutSessionParams({
          bookId,
          bookTitle: book.title,
          priceMinorUnitsAtCheckout: intent.price_cents_at_checkout,
          expiresAtSeconds,
          origin,
          intentId: intent.intent_id,
        })
      : buildLegacyBookCheckoutSessionParams({
          bookId,
          bookTitle: book.title,
          priceCentsAtCheckout: intent.price_cents_at_checkout,
          authorStripeAccountId: authorAccount as string,
          expiresAtSeconds,
          origin,
          intentId: intent.intent_id,
        });

  let session: Stripe.Checkout.Session;
  try {
    session = await getStripe().checkout.sessions.create(
      sessionParams,
      {
        // Deterministic, not random: retrying this exact intent's
        // checkout-creation request (e.g. after an ambiguous network
        // failure) must never be able to create a second, independent
        // Stripe Checkout Session for the same frozen intent. Mirrors
        // buyBundle's identical `bundle-checkout:${snapshot_id}` pattern.
        idempotencyKey: `book-checkout:${intent.intent_id}`,
      },
    );
  } catch (err) {
    // A concurrent invocation (double-click, two tabs) racing on the
    // SAME idempotency key can land here: Stripe rejects a second
    // request using a key still being processed by an in-flight first
    // request, rather than queuing it. Sent back to a normal, retryable
    // error state instead of an unhandled exception. Every other Stripe
    // error is handled the same generic way buyBundle already handles
    // its own checkout-creation failures -- logged and redirected, never
    // left to crash.
    if (err instanceof Stripe.errors.StripeIdempotencyError) {
      redirect(`/books/${bookId}?error=Checkout+already+in+progress+-+please+try+again`);
    }
    console.error("buyBook: Stripe checkout session creation failed", {
      bookId,
      readerId: user.id,
      intentId: intent.intent_id,
      error: err,
    });
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  if (!session.url) {
    redirect(`/books/${bookId}?error=Could+not+start+checkout`);
  }

  // Audit-only, best-effort -- fulfillment never depends on this
  // succeeding, since the webhook's finalize_book_checkout_intent
  // resolves everything directly from metadata.intent_id, never from
  // this column. Performed with the ADMIN client: the request-scoped
  // client has no direct UPDATE privilege on book_checkout_intents at
  // all (migration 032 revokes it from authenticated/anon entirely --
  // only the RPC and the service-role webhook may touch this table).
  const admin = createAdminClient();
  const { error: linkBackError } = await admin
    .from("book_checkout_intents")
    .update({ stripe_checkout_session_id: session.id })
    .eq("id", intent.intent_id);

  if (linkBackError) {
    console.error("buyBook: failed to link back stripe_checkout_session_id onto the intent", {
      bookId,
      readerId: user.id,
      intentId: intent.intent_id,
      error: linkBackError,
    });
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
