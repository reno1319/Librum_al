"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";

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
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const priceCents = Math.round(Number(formData.get("price") ?? 0) * 100);

  if (!title || !Number.isFinite(priceCents) || priceCents < 0) {
    redirect("/dashboard/bundles?error=Please+fill+in+every+field");
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
      price_cents: priceCents,
    })
    .select("id")
    .single();

  if (insertError || !bundle) {
    redirect(
      `/dashboard/bundles?error=${encodeURIComponent(insertError?.message ?? "Could not create bundle")}`,
    );
  }

  await supabase
    .from("bundle_books")
    .insert(bookIds.map((bookId) => ({ bundle_id: bundle.id, book_id: bookId })));

  revalidatePath("/dashboard/bundles");
  redirect("/dashboard/bundles?success=Bundle+created+as+a+draft");
}

export async function updateBundle(bundleId: string, formData: FormData) {
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
  const priceCents = Math.round(Number(formData.get("price") ?? 0) * 100);

  if (!title || !Number.isFinite(priceCents) || priceCents < 0) {
    redirect(`/dashboard/bundles/${bundleId}/edit?error=Please+fill+in+every+field`);
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
    .update({ title, description, price_cents: priceCents })
    .eq("id", bundleId)
    .eq("author_id", user.id);

  if (updateError) {
    redirect(
      `/dashboard/bundles/${bundleId}/edit?error=${encodeURIComponent(updateError.message)}`,
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
  | { ok: false; reason: "not_found" | "read_failed" | "payout_required" | "update_failed" };

// FIX/bundle-payout-publication-gate: the bundle equivalent of
// performPublish() (books/actions.ts) -- a bundle with a real price must
// not publish unless the owning author's payout setup is enabled, for
// exactly the same reason a priced book can't: buyBundle() (bundles/[id]/
// actions.ts) requires bundle.profiles.stripe_account_id before it will
// ever construct a Stripe Checkout Session, so a published-but-unsellable
// bundle is otherwise fully public and looks purchasable while every
// checkout attempt dead-ends. This was the ONLY gap: publishBundle()
// previously updated status unconditionally with no payout check at all.
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
    .select("price_cents")
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

  // Free bundles never touch Stripe (buyBundle's own checkout-creation
  // path is the only thing that ever requires payout readiness), so
  // payout setup is only a real requirement for a bundle that will
  // actually be sold. price_cents is read fresh from the bundle's own
  // row here -- never trusted from the client.
  if (bundle.price_cents > 0) {
    const { data: profile, error: profileReadError } = await supabase
      .from("profiles")
      .select("stripe_payouts_enabled")
      .eq("id", userId)
      .maybeSingle();

    if (profileReadError) {
      console.error("performBundlePublish: profile read failed", { bundleId, userId, error: profileReadError });
      return { ok: false, reason: "read_failed" };
    }
    if (!profile?.stripe_payouts_enabled) {
      return { ok: false, reason: "payout_required" };
    }
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
    if (result.reason === "payout_required") {
      // Same message publishBook() uses for the identical situation --
      // see performPublish() (books/actions.ts).
      redirect("/dashboard/bundles?error=Connect+your+payout+account+before+publishing");
    }
    redirect("/dashboard/bundles");
  }

  revalidatePath("/dashboard/bundles");
}

export async function unpublishBundle(bundleId: string) {
  // AUTH-1C: defense-in-depth, mirroring publishBook()/unpublishBook()
  // -- same reasoning as publishBundle() above.
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
