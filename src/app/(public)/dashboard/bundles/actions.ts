"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { canPublishPaidTitle } from "@/lib/paid-readiness";
import { redirectForMaintenance, throwMaintenanceError } from "@/lib/maintenance-response";
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
const BUNDLE_SAVE_FAILED_MESSAGE = "Could not save the bundle. Please try again.";

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

  const { data: bundle, error: insertError } = await supabase
    .from("bundles")
    .insert({
      author_id: user.id,
      title,
      description,
      // ALL-WIRING-5: `price_all` ONLY. `price_cents` is deliberately
      // absent -- not written as 0, not derived -- so a new row takes the
      // column's own legacy default and nothing here speaks for it.
      price_all: parsedPrice.priceAll,
    })
    .select("id")
    .single();

  if (insertError || !bundle) {
    console.error("createBundle: bundle insert failed", { error: insertError });
    redirect(`/dashboard/bundles?error=${encodeURIComponent(BUNDLE_CREATE_FAILED_MESSAGE)}`);
  }

  await supabase
    .from("bundle_books")
    .insert(bookIds.map((bookId) => ({ bundle_id: bundle.id, book_id: bookId })));

  revalidatePath("/dashboard/bundles");
  redirect("/dashboard/bundles?success=Bundle+created+as+a+draft");
}

export async function updateBundle(bundleId: string, formData: FormData) {
  // ALL-CUTOVER APP-A: catalog price and membership are written by this
  // action -- gated before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(`/dashboard/bundles/${bundleId}/edit`);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: existing } = await supabase
    .from("bundles")
    .select("id")
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

  // Precedes the bundle update AND the membership delete/re-insert
  // below, so a rejected price leaves both exactly as they were.
  if (!parsedPrice.ok) {
    redirect(
      `/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(BUNDLE_PRICE_ERROR_MESSAGE)}`,
    );
  }

  const { bookIds, error: selectionError } = await resolveBookSelection(
    supabase,
    user.id,
    formData,
  );
  if (!bookIds) {
    redirect(`/dashboard/bundles/${bundleId}/edit?error=${selectionError}`);
  }

  const { error: updateError } = await supabase
    .from("bundles")
    // ALL-WIRING-5: `price_all` ONLY. Omitting `price_cents` is what
    // leaves an existing bundle's legacy value exactly as it was.
    .update({ title, description, price_all: parsedPrice.priceAll })
    .eq("id", bundleId)
    .eq("author_id", user.id);

  if (updateError) {
    console.error("updateBundle: bundle update failed", { bundleId, error: updateError });
    redirect(
      `/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(BUNDLE_SAVE_FAILED_MESSAGE)}`,
    );
  }

  // Simplest way to reconcile the book list: clear it and re-insert the
  // current selection, rather than diffing old vs new.
  await supabase.from("bundle_books").delete().eq("bundle_id", bundleId);
  await supabase
    .from("bundle_books")
    .insert(bookIds.map((bookId) => ({ bundle_id: bundleId, book_id: bookId })));

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
    .select("price_all")
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
  const { data: updatedRows, error: updateError } = await supabase
    .from("bundles")
    .update({ status: "published" })
    .eq("id", bundleId)
    .eq("author_id", userId)
    .select("id");

  if (updateError) {
    console.error("performBundlePublish: update failed", { bundleId, error: updateError });
    return { ok: false, reason: "update_failed" };
  }
  if (!updatedRows || updatedRows.length === 0) {
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

  await supabase
    .from("bundles")
    .update({ status: "draft" })
    .eq("id", bundleId)
    .eq("author_id", user.id);

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
