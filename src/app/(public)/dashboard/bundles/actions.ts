"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import {
  CATALOG_ROW_CHANGED_MESSAGE,
  PAID_REPRICING_UNAVAILABLE_MESSAGE,
  applyCatalogRowGuard,
  catalogRowGuard,
  isExactlyOneRowWritten,
  resolvePriceUpdateAuthorization,
} from "@/lib/paid-repricing";
import { redirectForMaintenance, throwMaintenanceError } from "@/lib/maintenance-response";
import {
  classifyBundleWriteFailure,
  isExactBundleMembership,
  isExactBundleState,
} from "@/lib/bundle-membership";
import {
  MAXIMUM_CATALOG_PRICE_ALL,
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  parseCatalogPriceAll,
  resolveCatalogPriceState,
} from "@/lib/catalog-price";

// ALL-WIRING-5: one message for every rejected bundle price, built from
// the catalog module's own constants so it cannot drift from the rule
// it states -- the same shape createBook/updateBook use. It never
// repeats what the author typed.
const BUNDLE_PRICE_ERROR_MESSAGE =
  `Enter the bundle price in lek: 0 for a free bundle, or a whole number from ` +
  `${MINIMUM_PAID_CATALOG_PRICE_ALL} to ${MAXIMUM_CATALOG_PRICE_ALL}`;

const MISSING_BUNDLE_PRICE_MESSAGE = "Set a valid ALL price before publishing this bundle.";

// Fixed messages for a failed bundle write. The database's own error
// text used to be redirected into the page verbatim; it is logged
// server-side instead and never shown.
const BUNDLE_CREATE_FAILED_MESSAGE = "Could not create the bundle. Please try again.";
const BUNDLE_UNPUBLISH_FAILED_MESSAGE = "Could not unpublish the bundle. Please try again.";
// BUNDLE-MEMBERSHIP-AUTH-1: a trusted bundle write either failed in the
// database -- whose transaction then rolled back, so nothing changed --
// or ended in a way the action cannot confirm (a lost or malformed
// response). The messages say exactly which, and nothing more.
const BUNDLE_SAVE_ROLLED_BACK_MESSAGE = "Could not save the bundle, so nothing was changed. Please try again.";
const BUNDLE_SAVE_UNCONFIRMED_MESSAGE =
  "We could not confirm whether your changes were saved. Reload this bundle to check before trying again.";
const BUNDLE_CREATE_UNCONFIRMED_MESSAGE =
  "We could not confirm whether the bundle was created. Check your bundles before trying again.";

// PHASE-2C bundle-membership-integrity: an explicit `.returns<T[]>()`
// shape for performBundlePublish()'s own bundle_books->books membership
// read, below -- the same established pattern this codebase already
// uses for a single-book embed elsewhere (see BundleBookRow in
// bundles/[id]/page.tsx). `books` is null only if the joined book row
// itself is gone (e.g. cascade-deleted) -- treated as an invalid member
// by performBundlePublish()'s own filter, never as a query failure.
type BundleMembershipRow = {
  book_id: string;
  books: { author_id: string; status: string } | null;
};

async function resolveBookSelection(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
) {
  const bookIds = formData.getAll("bookIds").map(String);

  if (bookIds.length < 2) {
    return { bookIds: null, error: "Choose+at+least+2+books" };
  }

  // BUNDLE-MEMBERSHIP-AUTH-1: a repeated id is refused outright rather
  // than left to the length comparison below to catch indirectly. The
  // trusted writer refuses duplicates too; this keeps the request from
  // ever reaching it.
  if (new Set(bookIds).size !== bookIds.length) {
    return { bookIds: null, error: "Choose+only+your+own+published+books" };
  }

  const { data: books } = await supabase
    .from("books")
    .select("id")
    .eq("author_id", userId)
    .eq("status", "published")
    .in("id", bookIds);

  if (!books || books.length !== bookIds.length) {
    return { bookIds: null, error: "Choose+only+your+own+published+books" };
  }

  return { bookIds, error: null };
}

export async function createBundle(formData: FormData) {
  // ALL-CUTOVER APP-A: catalog price is written by this action --
  // gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard/bundles");
  }

  // BUNDLE-MEMBERSHIP-AUTH-1: this action now obtains service-role
  // authority, so the recovery gate runs before it, exactly as in
  // publishBundle() -- before any Supabase call.
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  // ALL-WIRING-5: the ONLY accepted parse of a bundle's catalog price,
  // exactly as createBook's. `Math.round(Number(raw) * 100)` is gone: it
  // treated a missing price as 0 (free), accepted "1e3" and 0.5, ran the
  // author's string through binary floating point, and wrote the result
  // into the legacy USD column.
  const parsedPrice = parseCatalogPriceAll(formData.get("price"));

  if (!title) {
    redirect("/dashboard/bundles?error=Please+fill+in+every+field");
  }

  // A rejected price performs NO insert: this redirect precedes every
  // write in this function, bundle and membership alike.
  if (!parsedPrice.ok) {
    redirect(`/dashboard/bundles?error=${encodeURIComponent(BUNDLE_PRICE_ERROR_MESSAGE)}`);
  }

  const { bookIds, error: selectionError } = await resolveBookSelection(
    supabase,
    user.id,
    formData,
  );
  if (!bookIds) {
    redirect(`/dashboard/bundles?error=${selectionError}`);
  }

  // BUNDLE-MEMBERSHIP-AUTH-1: the bundle row and its membership are
  // written together, in ONE database transaction, by
  // public.create_bundle_with_membership -- through the trusted
  // catalog-write client, which is created only now, after the
  // maintenance and recovery gates, authentication, price validation and
  // the book-selection check. The function re-validates the selection
  // under row locks (at least two distinct books, each still existing,
  // owned by this author and published) and inserts nothing unless all
  // of it holds; after inserting it raises unless the stored membership
  // is exactly the selection. A refused or failed create therefore
  // leaves neither the bundle nor any membership behind.
  //
  // The payload is bound to the server, never to the client: the id is
  // generated here, `p_author_id` is the id auth.getUser() returned, and
  // the books are the ones resolveBookSelection() just proved are this
  // author's own published books. ALL-WIRING-5: `price_all` only --
  // `price_cents` takes its legacy column default. CATALOG-WRITE-AUTH-1:
  // `status` is never named, so the bundle is always a draft.
  const bundleId = randomUUID();
  const catalogWriter = createCatalogWriteClient();
  const { data: members, error: createError } = await catalogWriter.rpc("create_bundle_with_membership", {
    p_bundle_id: bundleId,
    p_author_id: user.id,
    p_title: title,
    p_description: description,
    p_price_all: parsedPrice.priceAll,
    p_book_ids: bookIds,
  });

  // Success only with proof: the returned rows must be exactly the
  // selected books, bound to exactly this new bundle. A database error
  // means the create rolled back; anything else (no SQLSTATE, or rows
  // that fail the proof) cannot be confirmed either way.
  if (createError || !isExactBundleMembership(members, bundleId, bookIds)) {
    const outcome = createError ? classifyBundleWriteFailure(createError) : "unconfirmed";
    console.error("createBundle: bundle and membership create failed", {
      bundleId,
      outcome,
      error: createError,
      rowCount: Array.isArray(members) ? members.length : null,
    });
    const message = outcome === "unconfirmed" ? BUNDLE_CREATE_UNCONFIRMED_MESSAGE : BUNDLE_CREATE_FAILED_MESSAGE;
    redirect(`/dashboard/bundles?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/bundles");
  redirect("/dashboard/bundles?success=Bundle+created+as+a+draft");
}

export async function updateBundle(bundleId: string, formData: FormData) {
  // ALL-CUTOVER APP-A: catalog price and membership are written by this
  // action -- gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/dashboard/bundles/${bundleId}/edit`);
  }

  // BUNDLE-MEMBERSHIP-AUTH-1: see createBundle -- service-role authority
  // is created below, so the recovery gate runs first.
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // PAID-REPRICING-1: `status` and `price_all` are read here so the
  // paid-repricing decision below comes from the server's own row.
  const { data: existing } = await supabase
    .from("bundles")
    .select("id, status, price_all")
    .eq("id", bundleId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (!existing) {
    redirect("/dashboard/bundles");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  // ALL-WIRING-5: see createBundle -- the same single parser.
  const parsedPrice = parseCatalogPriceAll(formData.get("price"));

  if (!title) {
    redirect(`/dashboard/bundles/${bundleId}/edit?error=Please+fill+in+every+field`);
  }

  // Precedes the single trusted save (details AND membership)
  // below, so a rejected price leaves both exactly as they were.
  if (!parsedPrice.ok) {
    redirect(
      `/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(BUNDLE_PRICE_ERROR_MESSAGE)}`,
    );
  }

  // PAID-REPRICING-1: the same shared rule updateBook() applies, so a
  // published bundle cannot become paid, or change its paid price, while
  // paid publishing is closed. Refused before the book-selection read,
  // the trusted save of details and membership.
  const priceAuthorization = resolvePriceUpdateAuthorization({
    currentStatus: existing.status,
    currentPriceAll: existing.price_all,
    submittedPriceAll: parsedPrice.priceAll,
  });
  if (
    priceAuthorization.kind === "paid_publishing_permission_required" &&
    !canPublishPaidTitle()
  ) {
    redirect(
      `/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(PAID_REPRICING_UNAVAILABLE_MESSAGE)}`,
    );
  }
  const priceGuard = catalogRowGuard(priceAuthorization, {
    status: existing.status,
    priceAll: existing.price_all,
  });

  const { bookIds, error: selectionError } = await resolveBookSelection(
    supabase,
    user.id,
    formData,
  );
  if (!bookIds) {
    redirect(`/dashboard/bundles/${bundleId}/edit?error=${selectionError}`);
  }

  // BUNDLE-MEMBERSHIP-AUTH-1: the COMPLETE edit -- details and books --
  // is ONE database transaction, public.update_bundle_with_membership,
  // called through the trusted catalog-write client, which is created
  // only now: after the maintenance and recovery gates, authentication,
  // the ownership read, input and price validation, the paid-repricing
  // decision and the book-selection check. The function
  //   * locks this bundle row, bound to this id AND the authenticated
  //     author, so concurrent complete edits serialize and the result is
  //     always exactly one of them -- never one edit's details with the
  //     other's books;
  //   * re-checks PAID-REPRICING-1's compare-and-set (the guard below) on
  //     that locked row, and refuses with LB409 if it changed;
  //   * writes title, description and `price_all` (ALL-WIRING-5: never
  //     `price_cents`, never `status`);
  //   * validates and locks every book, replaces the membership, and
  //     raises unless the stored membership and details are exactly what
  //     was submitted -- any failure rolls BOTH back;
  //   * returns the complete resulting state, proved below.
  const catalogWriter = createCatalogWriteClient();
  const { data: state, error: saveError } = await catalogWriter.rpc("update_bundle_with_membership", {
    p_bundle_id: bundleId,
    p_author_id: user.id,
    p_expected_status: priceGuard?.status ?? null,
    p_check_expected_price_all: priceGuard?.priceAll !== undefined,
    p_expected_price_all: priceGuard?.priceAll ?? null,
    p_title: title,
    p_description: description,
    p_price_all: parsedPrice.priceAll,
    p_book_ids: bookIds,
  });

  if (
    saveError ||
    !isExactBundleState(state, bundleId, bookIds, { title, description, priceAll: parsedPrice.priceAll })
  ) {
    const outcome = saveError ? classifyBundleWriteFailure(saveError) : "unconfirmed";
    console.error("updateBundle: bundle save failed", {
      bundleId,
      outcome,
      error: saveError,
      rowCount: Array.isArray(state) ? state.length : null,
    });
    if (outcome === "unconfirmed") {
      revalidatePath("/dashboard/bundles");
      revalidatePath(`/bundles/${bundleId}`);
    }
    const message =
      outcome === "changed"
        ? CATALOG_ROW_CHANGED_MESSAGE
        : outcome === "rolled_back"
          ? BUNDLE_SAVE_ROLLED_BACK_MESSAGE
          : BUNDLE_SAVE_UNCONFIRMED_MESSAGE;
    redirect(`/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/dashboard/bundles");
  revalidatePath(`/bundles/${bundleId}`);
  redirect("/dashboard/bundles?success=Bundle+updated");
}

type PerformBundlePublishResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "not_found"
        | "read_failed"
        | "missing_all_price"
        | "paid_mode_required"
        | "insufficient_members"
        | "update_failed";
    };

// PR-G: the bundle equivalent of performPublish() (books/actions.ts) --
// a bundle with a real price publishes only when canPublishPaidTitle()
// allows it, and since PR G that capability is the sole authorization.
//
// This block previously justified a stripe_payouts_enabled prerequisite
// by saying buyBundle() (bundles/[id]/actions.ts) requires
// bundle.profiles.stripe_account_id before it will ever construct a
// Stripe Checkout Session. That justification was already false on
// staging: buyBundle() has been an unconditional fail-closed redirect
// since STRIPE-DISABLE-1 and constructs no Checkout Session at all. The
// prerequisite is removed along with the claim -- publishBundle() is
// still not unconditional, because canPublishPaidTitle() denies whenever
// PAID_PUBLISHING_MODE is unset, which is everywhere today.
//
// Every Supabase read below inspects BOTH `data` and `error` explicitly --
// `.maybeSingle()` returns `{data: null, error: null}` for an ordinary
// zero-row result (no such bundle, or not owned by this author) and only
// ever sets `error` for a genuine query-execution failure, so the two
// cases are never conflated: a real database error must fail closed via
// "read_failed", never silently fall through as if it were an ordinary
// "not found".
async function performBundlePublish(
  supabase: Awaited<ReturnType<typeof createClient>>,
  bundleId: string,
  userId: string,
): Promise<PerformBundlePublishResult> {
  const { data: bundle, error: bundleReadError } = await supabase
    .from("bundles")
    .select("status, price_all")
    .eq("id", bundleId)
    .eq("author_id", userId)
    .maybeSingle();

  if (bundleReadError) {
    console.error("performBundlePublish: bundle read failed", { bundleId, error: bundleReadError });
    return { ok: false, reason: "read_failed" };
  }
  if (!bundle) {
    return { ok: false, reason: "not_found" };
  }

  // ALL-WIRING-5: the price is `price_all`, read fresh from the bundle's
  // own row -- never trusted from the client -- and classified three
  // ways, exactly as performPublish() classifies a book. `price_cents`
  // is not read at all: it is legacy USD, and its `0` default is not a
  // price, so it can decide nothing here.
  const catalogPriceState = resolveCatalogPriceState(bundle.price_all);

  // No authored ALL price (null, missing, or anything outside the
  // catalog domain): not publishable at any permission level, and never
  // treated as free. Refused before the membership read and before any
  // write. This refuses a PUBLISH only -- an already-published bundle
  // with a null price is not unpublished by this or anything else here.
  if (catalogPriceState === "unavailable") {
    return { ok: false, reason: "missing_all_price" };
  }

  // Only a bundle that will actually be sold needs paid-publishing
  // authorization at all -- price_all = 0 is explicitly free and
  // publishes with no paid-mode permission involved.
  if (catalogPriceState === "paid") {
    // PAID-MODE-1 / PR-G: identical placement and rationale to
    // performPublish() (dashboard/books/actions.ts) -- after the bundle's
    // own server-read price proves it is paid, and since PR G the sole
    // paid-publishing gate. A denial still costs nothing further: the
    // membership integrity read below is reached only once the capability
    // has allowed the publication, and no `profiles` row is read at any
    // price.
    if (!canPublishPaidTitle()) {
      return { ok: false, reason: "paid_mode_required" };
    }
  }

  // PHASE-2C bundle-membership-integrity: a bundle is only validly
  // publishable if EVERY membership row resolves to a book still owned
  // by this exact bundle's author and still published -- not merely "at
  // least 2 happen to be valid" (a weaker filtered-count check that
  // would let a bundle publish, and later checkout, as a silently
  // smaller or different bundle than its author actually selected).
  // totalMembers and validMembers are counted from two separate reads
  // (never one derived from the other by filtering), so a bundle with
  // e.g. 3 members where 1 is invalid is rejected outright, never
  // silently accepted as "a 2-book bundle." This mirrors, at publish
  // time, the exact same total-vs-valid comparison
  // create_bundle_checkout_snapshot() (supabase/schema.sql) now performs
  // at checkout time -- the database-level backstop for this same
  // invariant.
  const { data: memberRows, error: memberReadError } = await supabase
    .from("bundle_books")
    .select("book_id, books(author_id, status)")
    .eq("bundle_id", bundleId)
    .returns<BundleMembershipRow[]>();

  if (memberReadError) {
    console.error("performBundlePublish: membership read failed", { bundleId, error: memberReadError });
    return { ok: false, reason: "read_failed" };
  }

  const totalMembers = memberRows?.length ?? 0;
  const validMembers = (memberRows ?? []).filter((row) => {
    const book = row.books;
    return !!book && book.author_id === userId && book.status === "published";
  }).length;

  if (totalMembers !== validMembers || validMembers < 2) {
    return { ok: false, reason: "insufficient_members" };
  }

  // `.select("id")` on the update is required, not cosmetic: a plain
  // `.update(...).eq(...)` with no `.select()` returns `data: null` even
  // when it succeeds, so it cannot distinguish "updated exactly the
  // owned row" from "matched zero rows" (e.g. a bundle whose author_id
  // stopped matching between the read above and this write). Checking
  // the returned row array's length is what actually proves the
  // mutation affected the row this function verified ownership of --
  // mirroring the same pattern already used for the link-back update in
  // buyBundle() (bundles/[id]/actions.ts).
  //
  // PAID-REPRICING-1: also a compare-and-set on the status and price read
  // at the top of this function, exactly as performPublish() does for a
  // book. A concurrent updateBundle() that made a free draft paid after
  // that read leaves this publish matching no row, which the zero-row
  // check below already reports as a failure.
  //
  // CATALOG-WRITE-AUTH-1: `status` is protected, so this write goes
  // through the trusted catalog-write client, created only after the
  // ownership read, the price classification, the paid-publishing
  // permission and the membership integrity check above all passed.
  const catalogWriter = createCatalogWriteClient();
  const { data: updatedRows, error: updateError } = await applyCatalogRowGuard(
    catalogWriter
      .from("bundles")
      .update({ status: "published" })
      .eq("id", bundleId)
      .eq("author_id", userId),
    { status: bundle.status, priceAll: bundle.price_all },
  ).select("id");

  if (updateError) {
    console.error("performBundlePublish: update failed", { bundleId, error: updateError });
    return { ok: false, reason: "update_failed" };
  }
  if (!isExactlyOneRowWritten(updatedRows)) {
    console.error("performBundlePublish: update affected zero rows", { bundleId, userId });
    return { ok: false, reason: "update_failed" };
  }

  return { ok: true };
}

export async function publishBundle(bundleId: string) {
  // AUTH-1C: defense-in-depth, mirroring publishBook()/unpublishBook()
  // (src/app/dashboard/books/actions.ts) -- a bundle's publish state is
  // a public, buyer-facing change. Runs before any Supabase call.
  //
  // ALL-CUTOVER APP-A: the maintenance gate runs first of all --
  // publish re-validates bundle-membership integrity (migration 058)
  // against columns this cutover renames.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/dashboard/bundles");
  }

  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const result = await performBundlePublish(supabase, bundleId, user.id);

  if (!result.ok) {
    // ALL-WIRING-5: like publishBook()'s missing-price refusal, this one
    // is specific because it describes the author's OWN row back to them
    // and sends them to the one page that fixes it.
    if (result.reason === "missing_all_price") {
      redirect(
        `/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(MISSING_BUNDLE_PRICE_MESSAGE)}`,
      );
    }
    // PAID-MODE-1: same generic message publishBook() uses for the
    // identical situation -- it names no variable, environment or payout
    // state.
    if (result.reason === "paid_mode_required") {
      redirect("/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now");
    }
    if (result.reason === "insufficient_members") {
      redirect("/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books");
    }
    redirect("/dashboard/bundles");
  }

  revalidatePath("/dashboard/bundles");
}

export async function unpublishBundle(bundleId: string) {
  // AUTH-1C: defense-in-depth, mirroring publishBook()/unpublishBook()
  // -- same reasoning as publishBundle() above.
  //
  // ALL-CUTOVER APP-A: this function has no existing business-error
  // redirect convention of its own (it mutates and revalidates only),
  // so the maintenance rejection throws rather than inventing a new
  // redirect target.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    throwMaintenanceError();
  }

  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // CATALOG-WRITE-AUTH-1: `status` is protected, so the write goes
  // through the trusted catalog-write client, created only after
  // authentication. The `id` and `author_id` filters are the ownership
  // boundary; this action used to ignore its result entirely, and now
  // fails closed unless exactly one owned row changed.
  const catalogWriter = createCatalogWriteClient();
  const { data: updatedRows, error: updateError } = await catalogWriter
    .from("bundles")
    .update({ status: "draft" })
    .eq("id", bundleId)
    .eq("author_id", user.id)
    .select("id");

  if (updateError || !isExactlyOneRowWritten(updatedRows)) {
    console.error("unpublishBundle: update did not change exactly one row", {
      bundleId,
      userId: user.id,
      error: updateError,
    });
    redirect(`/dashboard/bundles?error=${encodeURIComponent(BUNDLE_UNPUBLISH_FAILED_MESSAGE)}`);
  }

  revalidatePath("/dashboard/bundles");
}

export async function deleteBundle(bundleId: string) {
  // AUTH-1C: defense-in-depth, mirroring deleteBook() -- bundle
  // deletion is irreversible. Runs before any Supabase call.
  //
  // ALL-CUTOVER APP-A: same no-existing-redirect-convention reasoning
  // as unpublishBundle() above -- throws rather than inventing one.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    throwMaintenanceError();
  }

  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase.from("bundles").delete().eq("id", bundleId).eq("author_id", user.id);

  revalidatePath("/dashboard/bundles");
}
