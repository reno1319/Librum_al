"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { GENRES } from "@/lib/genres";

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024;

export async function createBook(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const previewText = String(formData.get("previewText") ?? "").trim();
  const genre = String(formData.get("genre") ?? "");
  const priceCents = Math.round(Number(formData.get("price") ?? 0) * 100);
  const cover = formData.get("cover") as File | null;
  const manuscript = formData.get("manuscript") as File | null;

  if (
    !title ||
    !cover ||
    cover.size === 0 ||
    !manuscript ||
    manuscript.size === 0 ||
    !Number.isFinite(priceCents) ||
    priceCents < 0
  ) {
    redirect("/dashboard/books/new?error=Please+fill+in+every+field");
  }

  if (!GENRES.includes(genre as (typeof GENRES)[number])) {
    redirect("/dashboard/books/new?error=Please+choose+a+genre");
  }

  if (!manuscript.name.toLowerCase().endsWith(".epub")) {
    redirect("/dashboard/books/new?error=The+manuscript+must+be+an+EPUB+file");
  }

  if (cover.size > MAX_COVER_BYTES) {
    redirect("/dashboard/books/new?error=Cover+image+must+be+under+5MB");
  }

  if (manuscript.size > MAX_MANUSCRIPT_BYTES) {
    redirect("/dashboard/books/new?error=Manuscript+must+be+under+50MB");
  }

  const bookId = randomUUID();
  const coverExt = cover.name.split(".").pop() || "jpg";
  const coverPath = `${user.id}/${bookId}-cover.${coverExt}`;
  const manuscriptPath = `${user.id}/${bookId}.epub`;

  const { error: coverError } = await supabase.storage
    .from("covers")
    .upload(coverPath, cover, { contentType: cover.type });

  if (coverError) {
    redirect(`/dashboard/books/new?error=${encodeURIComponent(coverError.message)}`);
  }

  const { error: manuscriptError } = await supabase.storage
    .from("manuscripts")
    .upload(manuscriptPath, manuscript, { contentType: "application/epub+zip" });

  if (manuscriptError) {
    redirect(`/dashboard/books/new?error=${encodeURIComponent(manuscriptError.message)}`);
  }

  const { error: insertError } = await supabase.from("books").insert({
    id: bookId,
    author_id: user.id,
    title,
    description,
    preview_text: previewText,
    genre,
    price_cents: priceCents,
    cover_path: coverPath,
    file_path: manuscriptPath,
    status: "draft",
  });

  if (insertError) {
    redirect(`/dashboard/books/new?error=${encodeURIComponent(insertError.message)}`);
  }

  revalidatePath("/dashboard");
  redirect("/dashboard");
}

export async function updateBook(bookId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: existing } = await supabase
    .from("books")
    .select("cover_path, file_path, author_id")
    .eq("id", bookId)
    .single();

  if (!existing || existing.author_id !== user.id) {
    redirect("/dashboard");
  }

  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  const previewText = String(formData.get("previewText") ?? "").trim();
  const genre = String(formData.get("genre") ?? "");
  const priceCents = Math.round(Number(formData.get("price") ?? 0) * 100);
  const cover = formData.get("cover") as File | null;
  const manuscript = formData.get("manuscript") as File | null;

  if (!title || !Number.isFinite(priceCents) || priceCents < 0) {
    redirect(`/dashboard/books/${bookId}/edit?error=Please+fill+in+every+field`);
  }

  if (!GENRES.includes(genre as (typeof GENRES)[number])) {
    redirect(`/dashboard/books/${bookId}/edit?error=Please+choose+a+genre`);
  }

  let coverPath = existing.cover_path;
  if (cover && cover.size > 0) {
    if (cover.size > MAX_COVER_BYTES) {
      redirect(`/dashboard/books/${bookId}/edit?error=Cover+image+must+be+under+5MB`);
    }

    const coverExt = cover.name.split(".").pop() || "jpg";
    const newCoverPath = `${user.id}/${bookId}-cover.${coverExt}`;

    const { error: coverError } = await supabase.storage
      .from("covers")
      .upload(newCoverPath, cover, { contentType: cover.type, upsert: true });

    if (coverError) {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(coverError.message)}`);
    }

    if (existing.cover_path && existing.cover_path !== newCoverPath) {
      await supabase.storage.from("covers").remove([existing.cover_path]);
    }

    coverPath = newCoverPath;
  }

  let filePath = existing.file_path;
  if (manuscript && manuscript.size > 0) {
    if (!manuscript.name.toLowerCase().endsWith(".epub")) {
      redirect(`/dashboard/books/${bookId}/edit?error=The+manuscript+must+be+an+EPUB+file`);
    }

    if (manuscript.size > MAX_MANUSCRIPT_BYTES) {
      redirect(`/dashboard/books/${bookId}/edit?error=Manuscript+must+be+under+50MB`);
    }

    // Manuscripts always live at the same "<author>/<bookId>.epub" path,
    // so this simply overwrites the old file in place.
    const newManuscriptPath = `${user.id}/${bookId}.epub`;

    const { error: manuscriptError } = await supabase.storage
      .from("manuscripts")
      .upload(newManuscriptPath, manuscript, {
        contentType: "application/epub+zip",
        upsert: true,
      });

    if (manuscriptError) {
      redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(manuscriptError.message)}`);
    }

    filePath = newManuscriptPath;
  }

  const { error: updateError } = await supabase
    .from("books")
    .update({
      title,
      description,
      preview_text: previewText,
      genre,
      price_cents: priceCents,
      cover_path: coverPath,
      file_path: filePath,
    })
    .eq("id", bookId)
    .eq("author_id", user.id);

  if (updateError) {
    redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(updateError.message)}`);
  }

  revalidatePath("/dashboard");
  revalidatePath(`/books/${bookId}`);
  revalidatePath("/");
  redirect("/dashboard?success=Book+updated");
}

export async function publishBook(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("stripe_payouts_enabled")
    .eq("id", user.id)
    .single();

  if (!profile?.stripe_payouts_enabled) {
    redirect("/dashboard?error=Connect+your+payout+account+before+publishing");
  }

  await supabase
    .from("books")
    .update({ status: "published" })
    .eq("id", bookId)
    .eq("author_id", user.id);

  revalidatePath("/dashboard");
  revalidatePath("/");
}

export async function unpublishBook(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("books")
    .update({ status: "draft" })
    .eq("id", bookId)
    .eq("author_id", user.id);

  revalidatePath("/dashboard");
  revalidatePath("/");
}

export async function deleteBook(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: book } = await supabase
    .from("books")
    .select("cover_path, file_path")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .single();

  if (book?.cover_path) {
    await supabase.storage.from("covers").remove([book.cover_path]);
  }
  if (book?.file_path) {
    await supabase.storage.from("manuscripts").remove([book.file_path]);
  }

  await supabase.from("books").delete().eq("id", bookId).eq("author_id", user.id);

  revalidatePath("/dashboard");
  revalidatePath("/");
}
