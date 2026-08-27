"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GENRES } from "@/lib/genres";
import { CONTRIBUTOR_ROLES } from "@/lib/contributor-roles";
import { sendNewBookEmails } from "@/lib/email";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import { validateEpubStructure } from "@/lib/epub-validation";

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024;

// Stored as a single comma-separated string (searched the same way as
// title/description) rather than a Postgres array — simpler to search
// and edit, and tags don't need to be a distinct type for this MVP.
function normalizeKeywords(raw: FormDataEntryValue | null): string {
  return String(raw ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, 15)
    .join(", ");
}

// Confirms the chosen series actually belongs to this author (an empty
// selection is always valid — a book doesn't have to be in a series).
// Redirects back with an error rather than returning one, matching the
// other field validations in this file.
async function resolveSeriesSelection(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
  errorPath: string,
) {
  const seriesId = String(formData.get("seriesId") ?? "").trim() || null;
  if (!seriesId) {
    return { seriesId: null, seriesPosition: null };
  }

  const { data: series } = await supabase
    .from("series")
    .select("id")
    .eq("id", seriesId)
    .eq("author_id", userId)
    .maybeSingle();

  if (!series) {
    redirect(`${errorPath}?error=Choose+one+of+your+own+series`);
  }

  const rawPosition = String(formData.get("seriesPosition") ?? "").trim();
  const seriesPosition = rawPosition ? Number(rawPosition) : null;
  if (seriesPosition != null && (!Number.isInteger(seriesPosition) || seriesPosition < 1)) {
    redirect(`${errorPath}?error=Series+position+must+be+a+positive+whole+number`);
  }

  return { seriesId, seriesPosition };
}

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
  const keywords = normalizeKeywords(formData.get("keywords"));
  const isbn = String(formData.get("isbn") ?? "").trim() || null;
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

  const { seriesId, seriesPosition } = await resolveSeriesSelection(
    supabase,
    user.id,
    formData,
    "/dashboard/books/new",
  );

  if (!manuscript.name.toLowerCase().endsWith(".epub")) {
    redirect("/dashboard/books/new?error=The+manuscript+must+be+an+EPUB+file");
  }

  if (cover.size > MAX_COVER_BYTES) {
    redirect("/dashboard/books/new?error=Cover+image+must+be+under+5MB");
  }

  if (manuscript.size > MAX_MANUSCRIPT_BYTES) {
    redirect("/dashboard/books/new?error=Manuscript+must+be+under+50MB");
  }

  const coverKind = await detectCoverImageKind(cover);
  if (!coverKind) {
    redirect(
      "/dashboard/books/new?error=That+doesn%27t+look+like+a+valid+JPEG+or+PNG+image",
    );
  }
  const { extension: coverExtension, contentType: coverContentType } =
    resolveVerifiedCoverStorageDetails(coverKind);

  // Read once, reused for both validation and the upload below, rather
  // than reading the manuscript twice.
  const manuscriptBytes = Buffer.from(await manuscript.arrayBuffer());
  const manuscriptValidation = await validateEpubStructure(manuscriptBytes);
  if (!manuscriptValidation.valid) {
    redirect(
      "/dashboard/books/new?error=This+file+doesn%27t+appear+to+be+a+valid+EPUB",
    );
  }

  const bookId = randomUUID();
  // LAUNCH-1 P3-1: coverExtension is derived exclusively from the
  // verified byte signature above -- cover.name never reaches this key.
  const coverPath = `${user.id}/${bookId}-cover.${coverExtension}`;
  const manuscriptPath = `${user.id}/${bookId}.epub`;

  const { error: coverError } = await supabase.storage
    .from("covers")
    .upload(coverPath, cover, { contentType: coverContentType });

  if (coverError) {
    console.error("createBook: cover upload failed:", coverError);
    redirect(
      "/dashboard/books/new?error=Could+not+upload+your+cover+image.+Please+try+again",
    );
  }

  const { error: manuscriptError } = await supabase.storage
    .from("manuscripts")
    .upload(manuscriptPath, manuscriptBytes, { contentType: "application/epub+zip" });

  if (manuscriptError) {
    console.error("createBook: manuscript upload failed:", manuscriptError);
    redirect(
      "/dashboard/books/new?error=Could+not+upload+your+manuscript.+Please+try+again",
    );
  }

  // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT LEGACY RETIREMENT: preview_text is
  // deliberately NOT set here -- the Studio no longer collects it (Read
  // Sample is generated automatically, no author input required), so
  // this simply lets the column's own `not null default ''` apply, the
  // same as any other new-row default this insert doesn't override.
  const { error: insertError } = await supabase.from("books").insert({
    id: bookId,
    author_id: user.id,
    title,
    description,
    keywords,
    isbn,
    genre,
    series_id: seriesId,
    series_position: seriesPosition,
    price_cents: priceCents,
    cover_path: coverPath,
    file_path: manuscriptPath,
    status: "draft",
  });

  if (insertError) {
    console.error("createBook: book insert failed:", insertError);
    redirect(
      "/dashboard/books/new?error=Something+went+wrong+saving+your+book.+Please+try+again",
    );
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
  const keywords = normalizeKeywords(formData.get("keywords"));
  const isbn = String(formData.get("isbn") ?? "").trim() || null;
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

  const { seriesId, seriesPosition } = await resolveSeriesSelection(
    supabase,
    user.id,
    formData,
    `/dashboard/books/${bookId}/edit`,
  );

  let coverPath = existing.cover_path;
  // Only set once a replacement cover has actually been uploaded
  // successfully -- the old file is removed AFTER the DB update below
  // succeeds, never before, so a failed update never leaves
  // books.cover_path pointing at a file that's already gone.
  let coverPathToRemove: string | null = null;
  if (cover && cover.size > 0) {
    if (cover.size > MAX_COVER_BYTES) {
      redirect(`/dashboard/books/${bookId}/edit?error=Cover+image+must+be+under+5MB`);
    }

    const coverKind = await detectCoverImageKind(cover);
    if (!coverKind) {
      redirect(
        `/dashboard/books/${bookId}/edit?error=That+doesn%27t+look+like+a+valid+JPEG+or+PNG+image`,
      );
    }
    const { extension: coverExtension, contentType: coverContentType } =
      resolveVerifiedCoverStorageDetails(coverKind);

    // LAUNCH-1 P3-1: coverExtension is derived exclusively from the
    // verified byte signature above -- cover.name never reaches this
    // key. An existing.cover_path from before this hardening (e.g.
    // "...-cover.JPG" or "...-cover.jpeg") is unaffected: it's read
    // from the DB, not reconstructed here, so it remains removable via
    // coverPathToRemove below exactly as before.
    const newCoverPath = `${user.id}/${bookId}-cover.${coverExtension}`;

    const { error: coverError } = await supabase.storage
      .from("covers")
      .upload(newCoverPath, cover, { contentType: coverContentType, upsert: true });

    if (coverError) {
      console.error("updateBook: cover upload failed:", coverError);
      redirect(
        `/dashboard/books/${bookId}/edit?error=Could+not+upload+your+cover+image.+Please+try+again`,
      );
    }

    if (existing.cover_path && existing.cover_path !== newCoverPath) {
      coverPathToRemove = existing.cover_path;
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

    // Read once, reused for both validation and the upload below.
    const manuscriptBytes = Buffer.from(await manuscript.arrayBuffer());
    const manuscriptValidation = await validateEpubStructure(manuscriptBytes);
    if (!manuscriptValidation.valid) {
      redirect(
        `/dashboard/books/${bookId}/edit?error=This+file+doesn%27t+appear+to+be+a+valid+EPUB`,
      );
    }

    // Manuscripts always live at the same "<author>/<bookId>.epub" path,
    // so this simply overwrites the old file in place.
    const newManuscriptPath = `${user.id}/${bookId}.epub`;

    const { error: manuscriptError } = await supabase.storage
      .from("manuscripts")
      .upload(newManuscriptPath, manuscriptBytes, {
        contentType: "application/epub+zip",
        upsert: true,
      });

    if (manuscriptError) {
      console.error("updateBook: manuscript upload failed:", manuscriptError);
      redirect(
        `/dashboard/books/${bookId}/edit?error=Could+not+upload+your+manuscript.+Please+try+again`,
      );
    }

    filePath = newManuscriptPath;
  }

  // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT LEGACY RETIREMENT: preview_text is
  // deliberately OMITTED from this update payload -- the Studio form no
  // longer submits it at all, and a Supabase `.update()` only ever
  // touches the keys actually present in the object passed here (unlike
  // a full-row PUT/replace). Omitting the key means this column is
  // simply never written by this call, so any legacy value already
  // stored for an existing book survives editing untouched. Explicitly
  // NOT `preview_text: String(formData.get("previewText") ?? "")`,
  // which would have silently overwritten every existing legacy value
  // with an empty string the very first time each book was next edited.
  const { error: updateError } = await supabase
    .from("books")
    .update({
      title,
      description,
      keywords,
      isbn,
      genre,
      series_id: seriesId,
      series_position: seriesPosition,
      price_cents: priceCents,
      cover_path: coverPath,
      file_path: filePath,
    })
    .eq("id", bookId)
    .eq("author_id", user.id);

  if (updateError) {
    console.error("updateBook: book update failed:", updateError);
    redirect(
      `/dashboard/books/${bookId}/edit?error=Something+went+wrong+saving+your+changes.+Please+try+again`,
    );
  }

  // Only now that the DB row correctly points at the new cover is it
  // safe to remove the file it superseded. A cleanup failure here is an
  // orphaned-file problem, not a failed update -- same philosophy as
  // deleteBook's storage cleanup in Phase 8A: log it, don't tell the
  // author their update failed, don't undo the already-successful save.
  if (coverPathToRemove) {
    const { error: cleanupError } = await supabase.storage
      .from("covers")
      .remove([coverPathToRemove]);
    if (cleanupError) {
      console.error("updateBook: failed to remove superseded cover file:", cleanupError);
    }
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

  const { data: book } = await supabase
    .from("books")
    .select("status, price_cents")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .single();

  if (!book) {
    redirect("/dashboard");
  }

  // Free books never touch Stripe (see getFreeBook), so payout
  // readiness is only a real requirement for a book that will actually
  // be sold. price_cents is read fresh from the book's own row here --
  // never trusted from the client -- so this can't be spoofed by
  // submitting some other "free" signal.
  if (book.price_cents > 0) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_payouts_enabled")
      .eq("id", user.id)
      .single();

    if (!profile?.stripe_payouts_enabled) {
      redirect("/dashboard?error=Connect+your+payout+account+before+publishing");
    }
  }

  // Only a genuine draft -> published transition should notify
  // followers — otherwise every unpublish/republish toggle would spam
  // them again.
  await supabase
    .from("books")
    .update({ status: "published" })
    .eq("id", bookId)
    .eq("author_id", user.id);

  if (book.status === "draft") {
    const admin = createAdminClient();
    await sendNewBookEmails(admin, { bookId, authorId: user.id });
  }

  revalidatePath("/dashboard");
  revalidatePath("/");
  redirect("/dashboard?success=Your+book+is+now+live");
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

  if (!book) {
    redirect("/dashboard");
  }

  // A book with ANY acquisition history -- paid, free, or refunded --
  // must never be hard-deletable: those purchases rows are readers'
  // permanent record of ownership. count/head avoids reading the rows
  // themselves; the "Authors can view purchases of their own books" RLS
  // policy already lets this count run as the owning author. Unpublish
  // is the only removal path once any row exists (the database itself
  // also enforces this via purchases.book_id's foreign key -- see
  // supabase/migrations -- so this app-level check is a UX nicety on
  // top of a real, authoritative guarantee, not the only thing standing
  // between a book and its buyers' purchase history).
  const { count: purchaseCount } = await supabase
    .from("purchases")
    .select("id", { count: "exact", head: true })
    .eq("book_id", bookId);

  if ((purchaseCount ?? 0) > 0) {
    redirect(
      "/dashboard?error=This+book+has+been+acquired+by+readers+and+can%27t+be+deleted+-+unpublish+it+instead",
    );
  }

  // The books row is deleted BEFORE any storage cleanup is attempted --
  // deliberately, not incidentally. The count check above is only an
  // advisory, point-in-time snapshot: a reader could acquire this book
  // in the window between that check and this delete. Once migration
  // 023 is applied, purchases.book_id's ON DELETE RESTRICT makes this
  // delete itself the authoritative, race-proof guard -- it will fail
  // if a purchase now exists, and because it runs first, no file has
  // been touched yet if that happens. Deleting storage first would risk
  // destroying a legitimate new buyer's manuscript even though their
  // purchase record (and the book row) end up surviving.
  const { error: deleteError } = await supabase
    .from("books")
    .delete()
    .eq("id", bookId)
    .eq("author_id", user.id);

  if (deleteError) {
    // 23503 is Postgres's foreign_key_violation code -- once migration
    // 023 is applied, this is exactly the race this whole ordering
    // exists to catch: a purchase appeared after the advisory count
    // check above but before this delete ran, and purchases.book_id's
    // ON DELETE RESTRICT rejected the delete to protect it. That's the
    // same "acquired by readers" case as the earlier check, not a
    // generic failure, so it gets the same friendly message rather than
    // a raw constraint-violation string.
    if (deleteError.code === "23503") {
      redirect(
        "/dashboard?error=This+book+has+been+acquired+by+readers+and+can%27t+be+deleted+-+unpublish+it+instead",
      );
    }
    redirect("/dashboard?error=Could+not+delete+that+book+right+now");
  }

  // The book row is gone at this point -- from the author's perspective
  // the deletion already succeeded. Any failure past here is an orphan
  // storage file to clean up later, not a failed book deletion, so it's
  // logged rather than surfaced as an error, and the row is never
  // recreated to "undo" a partially-completed cleanup.
  if (book.cover_path) {
    const { error: coverError } = await supabase.storage
      .from("covers")
      .remove([book.cover_path]);
    if (coverError) {
      console.error("deleteBook: failed to remove orphaned cover file:", coverError);
    }
  }

  if (book.file_path) {
    const { error: manuscriptError } = await supabase.storage
      .from("manuscripts")
      .remove([book.file_path]);
    if (manuscriptError) {
      console.error(
        "deleteBook: failed to remove orphaned manuscript file:",
        manuscriptError,
      );
    }
  }

  revalidatePath("/dashboard");
  revalidatePath("/");
}

export async function addContributor(bookId: string, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const name = String(formData.get("name") ?? "").trim();
  const role = String(formData.get("role") ?? "");

  if (!name || !CONTRIBUTOR_ROLES.includes(role as (typeof CONTRIBUTOR_ROLES)[number])) {
    redirect(`/dashboard/books/${bookId}/edit?error=Enter+a+name+and+choose+a+role`);
  }

  const { data: book } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (!book) {
    redirect("/dashboard");
  }

  const { error } = await supabase.from("book_contributors").insert({
    book_id: bookId,
    name,
    role,
  });

  if (error) {
    redirect(`/dashboard/books/${bookId}/edit?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath(`/dashboard/books/${bookId}/edit`);
  revalidatePath(`/books/${bookId}`);
  redirect(`/dashboard/books/${bookId}/edit?success=Contributor+added`);
}

export async function removeContributor(bookId: string, contributorId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // RLS also enforces this (the delete policy checks the book's
  // author_id), but this makes the ownership check explicit here too.
  const { data: book } = await supabase
    .from("books")
    .select("id")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();

  if (!book) {
    redirect("/dashboard");
  }

  await supabase.from("book_contributors").delete().eq("id", contributorId);

  revalidatePath(`/dashboard/books/${bookId}/edit`);
  revalidatePath(`/books/${bookId}`);
}
