"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveCatalogPriceState } from "@/lib/catalog-price";
import { REPORT_REASONS } from "@/lib/report-reasons";
import { resolveSiteOrigin } from "@/lib/site-url";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { BOOK_CHECKOUT_UNAVAILABLE_MESSAGE } from "@/lib/connect-account";
import { resolveActiveCheckoutProvider } from "@/lib/checkout-regime";
import { canStartPaidCheckout } from "@/lib/paid-readiness";
import { createPokClient, getPokConfig, type PokConfig } from "@/lib/pok";
import {
  startPokCheckout,
  POK_CHECKOUT_CANNOT_RESUME,
  POK_CHECKOUT_MAINTENANCE_ACTIVE,
  POK_CHECKOUT_IN_PROGRESS,
  POK_CHECKOUT_AMBIGUOUS,
  POK_CHECKOUT_ATTEMPT_RETIRED,
  probeProviderAttempt,
} from "@/lib/pok-checkout";
import { createPokRepository } from "@/lib/pok-repository";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import type { DiscountCode } from "@/lib/types";

type BookForCheckout = {
  id: string;
  title: string;
  // ALL-WIRING-2: the catalog price this checkout is about, in WHOLE
  // ALL. `price_cents` is not selected here at all any more -- not
  // read, not compared, not converted. It is legacy USD minor units and
  // its `0` default is not a price.
  price_all: number | null;
  status: string;
  author_id: string;
};

// The shape create_book_checkout_intent (migration 032) returns.
//
// STALE-CHECKOUT-1: quote_status is new, and it is the whole point --
// the RPC used to answer "here is your intent" and say nothing about
// WHICH of several very different situations produced it. A reused quote
// whose economics no longer match the reader's request is not the same
// event as a freshly minted one, and treating them alike is how a newly
// entered discount code was silently ignored and the reader charged the
// old price.
type CheckoutQuoteStatus =
  // A brand-new quote at the CURRENT price, code, publication state and
  // regime. Any stale predecessor was superseded atomically first.
  | "minted"
  // The existing quote, whose economics are identical to this request's.
  | "reused"
  // The economics moved, but the old attempt may still be payable, so
  // nothing was mutated. Needs a provider round trip, or a deliberate
  // reader choice.
  | "conflict_attempt_unresolved"
  // The intent's own 23 hours elapsed, but its attempt has a recorded
  // provider order id (or an id-less window still inside the margin), so
  // local expiry alone may not retire it.
  | "blocked_expired_attempt_unresolved"
  // A legacy Stripe-bound quote. Never superseded: its session may still
  // be payable and this code can no longer reach Stripe to find out.
  | "blocked_legacy_attempt"
  // Deliberate-resume only: the exact intent the reader confirmed is no
  // longer the eligible candidate. Never resumes something else.
  | "expected_intent_changed"
  // The temporary per-reader, per-book supersession guard.
  | "supersession_rate_limited"
  // ALL-WIRING-2: the reader supplied a code the database still
  // considers active, but it is a LEGACY USD `amount_off_cents` code.
  // Its number is not an amount of lek, so it is never applied to an
  // ALL checkout -- and never silently ignored either, because
  // ignoring it would charge the full price on a request in which the
  // reader did supply a valid-looking code. Nothing was mutated.
  | "discount_not_applicable"
  // ALL-WIRING-2: the discount resolved to less than Librum's 99 ALL
  // paid floor. The old behaviour CLAMPED such a result back up to a
  // floor, which charged MORE with a code than without one; that clamp
  // is deleted, and this status is the rejection that replaced it. The
  // reader is never quietly charged the full price, and never charged
  // an amount raised above what the code implied. Nothing was mutated.
  | "discount_below_minimum";

type CheckoutIntentResult = {
  intent_id: string | null;
  price_cents_at_checkout: number | null;
  discount_code_id: string | null;
  expires_at: string | null;
  quote_status: CheckoutQuoteStatus;
};

// ALL-WIRING-2 CORRECTION (Codex finding 2): the two discount
// rejections are classified in ONE place -- inside createQuote, before
// it returns -- rather than at each call site.
//
// Why a TYPE and not just a shared helper. buyBook calls createQuote
// from four places: the initial quote, the expected_intent_changed
// re-evaluation, the replacement minted after a provider probe proves
// the old attempt retired, and the replacement minted after
// POK_CHECKOUT_ATTEMPT_RETIRED. The last two accepted only `minted` or
// `reused` and folded everything else into the generic ambiguous
// message -- so a discount rejection arriving on a REPLACEMENT (which
// is a real possibility: eligibility can change between the first RPC
// and the replacement) told the reader to try again in a few minutes
// instead of telling them their code was not applied.
//
// Screening inside createQuote and REMOVING the two statuses from the
// returned type makes that class of omission unrepresentable: a future
// call site cannot forget the check, because the value it receives can
// no longer carry either status, and a leftover comparison against one
// of them becomes a compile error rather than dead code that reads as
// coverage.
type DiscountRejectionStatus = "discount_not_applicable" | "discount_below_minimum";

type ScreenedQuote = Omit<CheckoutIntentResult, "quote_status"> & {
  quote_status: Exclude<CheckoutQuoteStatus, DiscountRejectionStatus>;
};

// STALE-CHECKOUT-1: reader-facing copy, kept in one place so the same
// situation always reads the same way. Every one of these is an honest
// statement of what Librum actually knows -- none of them implies a
// retry will work when it will not, and none of them claims a discount
// was applied when it was not.
const CHECKOUT_IN_PROGRESS_MESSAGE =
  "Your checkout is starting. Please try again in a moment.";
const CHECKOUT_AMBIGUOUS_MESSAGE =
  "We can't safely reopen your previous checkout yet. Please try again in a few minutes.";
const CHECKOUT_NEEDS_REVIEW_MESSAGE =
  "This purchase needs review. If you already paid, check your library; otherwise please contact support.";
const CHECKOUT_LEGACY_BLOCKED_MESSAGE =
  "An earlier checkout for this book must finish or expire before you can start a new one.";
const CHECKOUT_RATE_LIMITED_MESSAGE =
  "Too many checkout attempts for this book. Please try again later.";
// ALL-WIRING-2: both of these say plainly that the code was NOT
// applied and that nothing was charged. Neither implies the purchase
// went through at full price, and neither invites the reader to retry
// the same code expecting a different answer.
const CHECKOUT_DISCOUNT_NOT_APPLICABLE_MESSAGE =
  "That promo code can't be used for this book, so nothing was charged. Remove the code to buy at the current price.";
const CHECKOUT_DISCOUNT_BELOW_MINIMUM_MESSAGE =
  "That promo code would bring this book below Librum's minimum price, so it can't be used and nothing was charged.";
// A payment was found but not yet PROVEN (POK reported the order
// completed without capture evidence we can verify). The reader must not
// be invited to pay again -- that is the one outcome with no remedy,
// since no refund path exists yet.
const CHECKOUT_PENDING_VERIFICATION_MESSAGE =
  "We haven't been able to confirm your payment yet. Check your library in a few minutes before paying again.";

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
    .select("id, title, price_all, status, author_id")
    .eq("id", bookId)
    .single<BookForCheckout>();

  if (!book || book.status !== "published" || book.author_id === user.id) {
    redirect(`/books/${bookId}`);
  }

  // ALL-WIRING-2: the catalog price is classified THREE ways, from the
  // book's own freshly re-read `price_all`. This is a server-side
  // invariant, not a UI convenience -- it holds even if buyBook were
  // invoked directly by a crafted POST.
  //
  //   unavailable -- no authored ALL price. Not free, not paid, not
  //                  purchasable. Never inferred as free, and never
  //                  fallen back to `price_cents`.
  //   free        -- must go through getFreeBook, never a paid provider.
  //   paid        -- the only case that continues below.
  //
  // create_book_checkout_intent independently refuses the first two
  // (see its own ALL-CHECKOUT-1 comment); this fork exists so a reader
  // gets an honest message instead of a generic RPC failure, not as the
  // authoritative check.
  const catalogPriceState = resolveCatalogPriceState(book.price_all);

  if (catalogPriceState === "unavailable") {
    redirect(`/books/${bookId}?error=This+book+isn%27t+available+to+buy+right+now`);
  }

  if (catalogPriceState === "free") {
    redirect(`/books/${bookId}?error=This+book+is+free+-+use+the+free+download+option+instead`);
  }

  // PAID-MODE-1: whether Librum may start a PAID checkout AT ALL is a
  // product permission, decided here, before and independently of which
  // provider would serve it. Until this gate existed, the provider
  // configuration immediately below was the only thing standing between
  // a reader and a charge -- a payment provider being configured is not
  // the same statement as "Librum is ready to take money", and this is
  // where the two stop being conflated.
  //
  // Placed AFTER the free-price fork above (free acquisition is never
  // gated -- see getFreeBook) and BEFORE provider resolution, so a
  // denial costs no RPC, no POK call and no checkout-intent row.
  //
  // The denial is the same generic message the provider-disabled path
  // uses, deliberately: a reader learns that checkout is unavailable and
  // nothing whatsoever about this deployment's configuration.
  if (!canStartPaidCheckout()) {
    redirect(`/books/${bookId}?error=${encodeURIComponent(BOOK_CHECKOUT_UNAVAILABLE_MESSAGE)}`);
  }

  // STRIPE-DISABLE-1: the single point that decides WHICH provider may
  // serve this checkout -- reached only after the independent paid-mode
  // permission above has already allowed a paid checkout to proceed at
  // all. Two separate decisions, in that order: whether Librum may take
  // money (PAID-MODE-1, above) and who would collect it (here).
  //
  // Server-only, never overridable by request input, and evaluated
  // through the single shared resolution policy
  // (src/lib/checkout-regime.ts) rather than a parallel ad hoc
  // comparison. Every configuration other than the exact pair
  // NEW_CHECKOUT_REGIME=librum_ledger_v1 / LEDGER_PAYMENT_PROVIDER=pok
  // -- missing, empty, malformed, wrong-cased, the pre-cutover legacy
  // default included -- fails closed HERE, before any RPC, POK, or
  // Stripe call, and before any checkout-intent or other DB state is
  // created. This intentionally removes the legacy Stripe Connect
  // checkout path entirely: no new Stripe buyer checkout may be created
  // by this action any more, only an exact-config POK checkout.
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

  // STALE-CHECKOUT-1: the deliberate-resume inputs. They arrive ONLY
  // from the separate second form the book page renders beside the
  // ordinary buy button (never as its default submit), and they are
  // validated here before they reach SQL. The intent id is a SELECTOR,
  // never authorization: create_book_checkout_intent independently
  // enforces auth.uid(), book identity and ownership, and resumes only
  // the exact intent it would have selected anyway.
  const resumeExisting = String(formData.get("resume_existing") ?? "") === "1";
  const expectedIntentRaw = String(formData.get("expected_intent_id") ?? "").trim();
  const expectedIntentId =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expectedIntentRaw)
      ? expectedIntentRaw
      : null;
  const acceptExistingQuote = resumeExisting && expectedIntentId !== null;

  // The sole source of truth for what POK actually charges from this
  // point forward -- price, the resolved discount, and this attempt's
  // own durable identity are all frozen atomically by this one call
  // (migration 032's create_book_checkout_intent, evolved by migrations
  // 056 and STALE-CHECKOUT-1). Never trusts the book row read above or
  // the discount lookup above for the actual charge -- both are re-derived
  // server-side inside the RPC, which is directly callable by any
  // authenticated client and so can never trust a caller-supplied price.
  //
  // ALL-WIRING-2: FOUR arguments, matching the only signature that now
  // exists (migration 20260922113721). `p_regime`, `p_currency` and
  // `p_royalty_rate_bps` are GONE -- removed from the surface, not
  // merely stopped being sent. The regime (librum_ledger_v1), the
  // currency (ALL) and the 8000 bps author royalty are now internal
  // constants of the function itself, because this RPC is directly
  // callable by any authenticated client: while they were parameters, a
  // direct caller could mint an intent that froze a royalty rate of its
  // own choosing onto the author's sale.
  const createQuote = async (
    accept: boolean,
    expected: string | null,
  ): Promise<ScreenedQuote> => {
    const { data: intentRows, error: intentError } = await supabase.rpc(
      "create_book_checkout_intent",
      {
        book_id: bookId,
        p_discount_code: rawCode || null,
        p_accept_existing_quote: accept,
        p_expected_intent_id: expected,
      },
    );

    const row = (intentRows as CheckoutIntentResult[] | null)?.[0];

    if (intentError || !row) {
      console.error("buyBook: create_book_checkout_intent failed", {
        bookId,
        readerId: user.id,
        error: intentError,
      });
      redirect(`/books/${bookId}?error=Could+not+start+checkout`);
    }

    // ALL-WIRING-2 CORRECTION: both discount rejections, classified
    // here so EVERY createQuote result passes through the same
    // handling -- initial call, expected_intent_changed re-evaluation,
    // provider-probe replacement and POK_CHECKOUT_ATTEMPT_RETIRED
    // replacement alike.
    //
    // The RPC returns both of these BEFORE its first mutation, so on
    // every one of those paths there is no new intent, no provider
    // order and no charge to unwind -- failing closed here IS the whole
    // handling, and it happens before any POK call and before any
    // further quote could be minted. The reader is told the code was
    // not applied and that nothing was charged; they are never sent
    // onward to pay the undiscounted price as if the code had been
    // accepted, and the code is never silently dropped and retried.
    if (row.quote_status === "discount_not_applicable") {
      failClosed(CHECKOUT_DISCOUNT_NOT_APPLICABLE_MESSAGE);
    }
    if (row.quote_status === "discount_below_minimum") {
      failClosed(CHECKOUT_DISCOUNT_BELOW_MINIMUM_MESSAGE);
    }

    return row as ScreenedQuote;
  };

  // A function DECLARATION, not a const arrow: TypeScript only treats a
  // call as never-returning for control-flow analysis when the callee is
  // a function declaration (or an explicitly typed const). As an arrow
  // this narrowed nothing, and every `result` assignment after it looked
  // possibly-unassigned.
  function failClosed(message: string): never {
    redirect(`/books/${bookId}?error=${encodeURIComponent(message)}`);
  }

  let quote = await createQuote(acceptExistingQuote, expectedIntentId);

  // STALE-CHECKOUT-1: the reader deliberately confirmed a specific quote
  // and it is no longer the eligible candidate. Re-evaluate EXACTLY once,
  // and never back into accept mode -- resuming "whatever is there now"
  // is precisely the silent substitution this status exists to prevent.
  if (quote.quote_status === "expected_intent_changed") {
    quote = await createQuote(false, null);
    if (quote.quote_status === "expected_intent_changed") {
      failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
    }
  }

  if (quote.quote_status === "blocked_legacy_attempt") {
    failClosed(CHECKOUT_LEGACY_BLOCKED_MESSAGE);
  }
  if (quote.quote_status === "supersession_rate_limited") {
    failClosed(CHECKOUT_RATE_LIMITED_MESSAGE);
  }
  // ALL-WIRING-2 CORRECTION: the two discount rejections used to be
  // handled HERE, which covered the initial quote and nothing else.
  // They are now screened inside createQuote itself (see ScreenedQuote),
  // so `quote` cannot carry either status at this point -- on any of the
  // four paths that produce one. This is not an omission: re-adding the
  // comparisons here would not compile.

  // At most ONE replacement quote is ever minted per reader action --
  // shared by the probe path below and the claim-race path further down,
  // so the two cannot compound into a loop.
  let replacementUsed = false;

  // STALE-CHECKOUT-1: SQL refused to decide, because the old attempt may
  // still accept payment and only an authenticated provider retrieval can
  // say. Nothing has been mutated at this point, and nothing will be
  // unless the probe proves the attempt dead.
  if (quote.quote_status === "conflict_attempt_unresolved" ||
      quote.quote_status === "blocked_expired_attempt_unresolved") {
    const conflictingIntentId = quote.intent_id;
    const wasConflict = quote.quote_status === "conflict_attempt_unresolved";
    if (!conflictingIntentId) {
      failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
    }
    const resolution = await probeProviderAttempt(
      { intentId: conflictingIntentId, merchantId: pokConfig.merchantId },
      createPokRepository(),
      createPokClient(pokConfig),
    );
    switch (resolution.kind) {
      case "retired":
        // The attempt is provably dead and its intent superseded, in one
        // transaction. This is the ONLY outcome that permits a
        // replacement.
        if (acceptExistingQuote) {
          // ...except on the deliberate-accept path. Retiring and
          // minting here would charge a DIFFERENT amount than the one
          // the reader just clicked to confirm, which is exactly the
          // harm the conflict notice exists to prevent. Tell them, and
          // let them choose again against the current price.
          redirect(`/books/${bookId}?checkout_expired=1`);
        }
        replacementUsed = true;
        quote = await createQuote(false, null);
        if (quote.quote_status !== "minted" && quote.quote_status !== "reused") {
          failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
        }
        break;
      case "fulfilled":
        redirect(`/books/${bookId}?purchase=success`);
        break;
      case "fulfilment_pending":
        failClosed(CHECKOUT_PENDING_VERIFICATION_MESSAGE);
        break;
      case "blocked":
      case "needs_reconciliation":
        failClosed(CHECKOUT_NEEDS_REVIEW_MESSAGE);
        break;
      case "resumable":
        if (wasConflict) {
          // A genuinely live quote at the OLD amount. Never silently
          // resumed, and never silently re-priced: the book page renders
          // the frozen amount, says plainly that the new price or code is
          // not applied to it, and offers resuming as a separate,
          // deliberate second action.
          redirect(`/books/${bookId}?checkout_conflict=${conflictingIntentId}`);
        }
        failClosed(CHECKOUT_IN_PROGRESS_MESSAGE);
        break;
      case "in_progress":
        failClosed(CHECKOUT_IN_PROGRESS_MESSAGE);
        break;
      default:
        failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
    }
  }

  if (quote.quote_status !== "minted" && quote.quote_status !== "reused") {
    failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
  }

  // `intentRows as CheckoutIntentResult[] | null` above is a
  // compile-time cast only -- it gives no runtime guarantee the RPC
  // actually returned well-formed values. Every field that flows into
  // the provider call below is checked explicitly before that call is
  // ever made.
  const isIntentUsable =
    typeof quote.intent_id === "string" &&
    quote.intent_id.length > 0 &&
    typeof quote.price_cents_at_checkout === "number" &&
    Number.isInteger(quote.price_cents_at_checkout) &&
    quote.price_cents_at_checkout > 0 &&
    typeof quote.expires_at === "string" &&
    Number.isFinite(Date.parse(quote.expires_at));

  if (!isIntentUsable) {
    console.error("buyBook: checkout intent RPC returned a malformed result", {
      bookId,
      readerId: user.id,
      quoteStatus: quote.quote_status,
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
  const runCheckout = async (intentId: string) =>
    startPokCheckout({
      intentId, readerId: user.id, title: book.title,
      origin, merchantId: pokConfig.merchantId,
    }, createPokRepository(), createPokClient(pokConfig));

  let result: Awaited<ReturnType<typeof runCheckout>>;
  try {
    result = await runCheckout(quote.intent_id as string);
  } catch (err) {
    // ALL-CUTOVER APP-A: startPokCheckout()'s own defense-in-depth
    // maintenance gate fired -- map it back to the exact same
    // deterministic redirect this function's own top-of-function gate
    // already produces, so the reader-visible outcome never depends on
    // which of the two layers actually caught the maintenance window.
    if (err instanceof Error && err.message === POK_CHECKOUT_MAINTENANCE_ACTIVE) {
      redirectForMaintenance(`/books/${bookId}`);
    }
    // STALE-CHECKOUT-1: the claim race resolved into a retirement while
    // we were starting -- the attempt was proved dead and superseded
    // atomically. One replacement, never a loop: if the single
    // replacement allowance is already spent, fail closed instead.
    if (err instanceof Error && err.message === POK_CHECKOUT_ATTEMPT_RETIRED && !replacementUsed && !acceptExistingQuote) {
      replacementUsed = true;
      const replacement = await createQuote(false, null);
      if ((replacement.quote_status !== "minted" && replacement.quote_status !== "reused") ||
          typeof replacement.intent_id !== "string") {
        failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
      }
      try {
        result = await runCheckout(replacement.intent_id as string);
      } catch {
        redirect(`/books/${bookId}?error=Could+not+start+checkout`);
      }
    } else if (err instanceof Error && err.message === POK_CHECKOUT_ATTEMPT_RETIRED) {
      failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
    } else if (err instanceof Error && err.message === POK_CHECKOUT_IN_PROGRESS) {
      // Another request for this same intent is mid-creation. Exactly one
      // provider order exists and no second payable one is created.
      failClosed(CHECKOUT_IN_PROGRESS_MESSAGE);
    } else if (err instanceof Error && err.message === POK_CHECKOUT_AMBIGUOUS) {
      failClosed(CHECKOUT_AMBIGUOUS_MESSAGE);
    } else if (err instanceof Error && err.message === POK_CHECKOUT_CANNOT_RESUME) {
      // A stale checkout can never be silently resumed -- tell the reader
      // that plainly instead of implying a retry will work.
      failClosed(
        "We can't safely reopen this checkout. If you already paid, check your library; otherwise, please contact support to complete this purchase.",
      );
    } else {
      redirect(`/books/${bookId}?error=Could+not+start+checkout`);
    }
  }

  // STALE-CHECKOUT-1: startPokCheckout no longer returns a bare URL. A
  // completed order found while resuming routes to fulfilment rather
  // than to a second payable order -- the classifier can only return
  // RETIRE_SAFE for an order with no completion, refund, transaction or
  // capture evidence, so a completed order is never retired and its
  // intent is never superseded.
  if (result.kind === "fulfilled") {
    redirect(`/books/${result.bookId}?purchase=success`);
  }
  if (result.kind === "fulfilment_pending") {
    redirect(`/books/${result.bookId}?error=${encodeURIComponent(CHECKOUT_PENDING_VERIFICATION_MESSAGE)}`);
  }
  if (result.kind === "blocked") {
    redirect(`/books/${result.bookId}?error=${encodeURIComponent(CHECKOUT_NEEDS_REVIEW_MESSAGE)}`);
  }
  redirect(result.url);
}

type BookForFreeAcquisition = {
  id: string;
  price_all: number | null;
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
    .select("id, price_all, status, author_id")
    .eq("id", bookId)
    .single<BookForFreeAcquisition>();

  // ALL-WIRING-2: `price_all === 0` EXACTLY, from this server-side
  // reread -- the sole condition under which a book may be claimed free.
  // Both other catalog states are refused: a paid book obviously, and a
  // book with NO authored ALL price too, because null is not free. That
  // second refusal is the whole point of the strict equality: an
  // `<= 0`, a falsy test, or a `price_cents` fallback would each hand a
  // free entitlement to an unpriced row.
  //
  // Free acquisition deliberately remains independent of paid-checkout
  // readiness: no canStartPaidCheckout() gate, no provider resolution,
  // no POK call, no payment row and no author-ledger sale entry exist on
  // this path at all, so there is nothing here for a paid-mode
  // permission to govern.
  if (
    !book ||
    book.status !== "published" ||
    book.price_all !== 0 ||
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
