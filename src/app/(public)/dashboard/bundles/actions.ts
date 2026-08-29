"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

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

export async function publishBundle(bundleId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("bundles")
    .update({ status: "published" })
    .eq("id", bundleId)
    .eq("author_id", user.id);

  revalidatePath("/dashboard/bundles");
}

export async function unpublishBundle(bundleId: string) {
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
