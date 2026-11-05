"use server";

// BD15 P2: the new book editor's server actions -- the Details tab's
// save (the first save creates the draft), and a series made from
// inside the editor. PLAN-BD15-r1 §2.2 and §2.3.
//
// What this patch does not do yet (later BD15 patches): the manuscript
// and cover (P3), the price and sending for review (P4), editing a
// live book or a book in review (P5: until then those stay on the
// existing edit page, which this action sends them to).
//
// BD15 P5b-2: a live book not waiting for review is saved here too and
// stays live. Its description, 18+ label and original author go to the
// book's waiting changes (book_pending_changes, src/lib/book-pending-
// changes.ts) -- Librum approves them before readers see them -- and
// everything else straight onto the live book. Its rights basis is
// fixed while it is live (Renato 11-04, Q4 a; LB492).

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { resolveOwnPenNameId } from "@/lib/pen-name-write-client";
import { penNameErrorMessage } from "@/lib/pen-names";
import { getRightsDeclarationState, recordRightsDeclaration } from "@/lib/book-rights";
import { getBookReviewState, isInReviewLockError, isWaitingForReview } from "@/lib/book-reviews";
import { BOOK_CHANGED_WHILE_EDITING_MESSAGE, IN_REVIEW_LOCKED_MESSAGE } from "@/lib/book-review-copy";
import { removeUnretainedManuscripts } from "@/lib/book-reviews";
import { BOOK_COVERS_BUCKET, isNewBookCoverPath } from "@/lib/book-storage-path";
import {
  changedPendingFields,
  discardPendingChanges,
  readPendingChanges,
  savePendingChanges,
  type PendingChanges,
} from "@/lib/book-pending-changes";
import { CATALOG_ROW_CHANGED_MESSAGE, isExactlyOneRowWritten } from "@/lib/paid-repricing";
import { parseBookDetails, type BookDetails, type DetailsContributor } from "@/lib/book-details";
import {
  CHANGES_DISCARDED_MESSAGE,
  CONTRIBUTORS_NOT_SAVED_MESSAGE,
  DETAILS_INVALID_MESSAGE,
  LIVE_ADULT_CATEGORY_MESSAGE,
  LIVE_NOT_LIVE_MESSAGE,
  LIVE_PARTLY_SAVED_MESSAGE,
  LIVE_RIGHTS_LOCKED_MESSAGE,
  LIVE_SAVED_MESSAGE,
  LIVE_SAVED_PENDING_MESSAGE,
  NO_CHANGES_TO_DISCARD_MESSAGE,
  DETAILS_SAVED_MESSAGE,
  RIGHTS_NOT_SAVED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  SERIES_NOT_OWN_MESSAGE,
  editorPath,
} from "@/lib/book-editor-copy";

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one book row this action may change: the caller's own draft or
// (P5b-2) live book. The five review values are read for a live book.
type ExistingBook = {
  id: string;
  author_id: string;
  status: string;
  published_at: string | null;
  title: string;
  pen_name_id: string;
  file_path: string | null;
  cover_path: string | null;
  description: string;
  is_adult: boolean;
  original_author: string | null;
};

function liveValuesOf(book: ExistingBook): PendingChanges {
  return {
    filePath: book.file_path,
    coverPath: book.cover_path,
    description: book.description,
    isAdult: book.is_adult,
    originalAuthor: book.original_author,
  };
}

async function readOwnBook(supabase: SessionClient, userId: string, bookId: string): Promise<ExistingBook | null> {
  if (!UUID.test(bookId)) return null;
  const { data, error } = await supabase
    .from("books")
    .select("id, author_id, status, published_at, title, pen_name_id, file_path, cover_path, description, is_adult, original_author")
    .eq("id", bookId)
    .eq("author_id", userId)
    .maybeSingle<ExistingBook>();
  if (error || !data || data.id !== bookId || data.author_id !== userId) return null;
  return data;
}

async function ownsPenName(supabase: SessionClient, userId: string, penNameId: string): Promise<boolean> {
  if (!UUID.test(penNameId)) return false;
  const { data } = await supabase
    .from("pen_names")
    .select("id")
    .eq("id", penNameId)
    .eq("author_id", userId)
    .maybeSingle<{ id: string }>();
  return data?.id === penNameId;
}

async function ownsSeries(supabase: SessionClient, userId: string, seriesId: string): Promise<boolean> {
  if (!UUID.test(seriesId)) return false;
  const { data } = await supabase
    .from("series")
    .select("id")
    .eq("id", seriesId)
    .eq("author_id", userId)
    .maybeSingle<{ id: string }>();
  return data?.id === seriesId;
}

// The book's contributors become exactly the submitted list (at most 3;
// the database refuses a fourth, LB486). Rows are matched by id: a kept
// row is left as it is, a removed one is deleted, a new one inserted.
// Ids the book doesn't have are ignored, never inserted. Written with the
// author's own session (RLS: own books only).
async function syncContributors(
  supabase: SessionClient,
  bookId: string,
  wanted: readonly DetailsContributor[],
): Promise<boolean> {
  const { data: current, error: readError } = await supabase
    .from("book_contributors")
    .select("id, name, role")
    .eq("book_id", bookId)
    .returns<{ id: string; name: string; role: string }[]>();
  if (readError) {
    console.error("saveBookDetails: contributors read failed", { bookId, code: readError.code ?? null });
    return false;
  }
  const rows = current ?? [];
  const keep = new Set<string>();
  const inserts: { book_id: string; name: string; role: string }[] = [];
  for (const c of wanted) {
    const match = c.id ? rows.find((r) => r.id === c.id) : undefined;
    if (match && match.name === c.name && match.role === c.role) keep.add(match.id);
    else inserts.push({ book_id: bookId, name: c.name, role: c.role });
  }
  const removals = rows.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (removals.length > 0) {
    const { error } = await supabase.from("book_contributors").delete().eq("book_id", bookId).in("id", removals);
    if (error) {
      console.error("saveBookDetails: contributors delete failed", { bookId, code: error.code ?? null });
      return false;
    }
  }
  if (inserts.length > 0) {
    const { error } = await supabase.from("book_contributors").insert(inserts);
    if (error) {
      console.error("saveBookDetails: contributors insert failed", { bookId, code: error.code ?? null });
      return false;
    }
  }
  return true;
}

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

// BD15 P5b-2: the Details save of a LIVE book (not in review: checked
// by the caller). In order, each step refusing before the next:
//   1. the rights basis is unchanged (LB492: fixed while live);
//   2. a live book keeps a description, and a chosen series is the
//      author's own;
//   3. every field that needs no review is written onto the live row
//      (bound to status 'published'); the reading age only when the 18+
//      label is not changing, so a waiting 18+ is not shown early;
//   4. the waiting version: the description, 18+ label and original
//      author with the waiting (or live) manuscript and ballinë. Equal
//      to the live book in all five: any waiting row is dropped instead;
//   5. contributors (the same sync as a draft).
// Step 3 runs before 4 so a book can leave a children/teen category and
// take the 18+ label in one save (LB493 is checked on the waiting row
// against the categories it then has).
async function saveLiveBookDetails(
  supabase: SessionClient,
  userId: string,
  existing: ExistingBook,
  details: BookDetails,
  formData: FormData,
): Promise<never> {
  const here = editorPath(existing.id, "details");
  const inReviewPage = () => redirect(withQuery(editorPath(existing.id, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));

  // 1. The rights basis.
  const rights = await getRightsDeclarationState(existing.id);
  if (rights.kind === "unavailable") redirect(withQuery(here, "error", SAVE_FAILED_MESSAGE));
  const currentBasis = rights.kind === "present" ? rights.declaration.basis : null;
  if (details.rightsBasis !== null && details.rightsBasis !== (currentBasis ?? "own_rights")) {
    redirect(withQuery(here, "error", LIVE_RIGHTS_LOCKED_MESSAGE));
  }

  // 2. A live book keeps a description; the series is the author's own.
  if (!details.description.trim()) redirect(withQuery(here, "error", DETAILS_INVALID_MESSAGE));
  if (details.seriesId && !(await ownsSeries(supabase, userId, details.seriesId))) {
    redirect(withQuery(here, "error", SERIES_NOT_OWN_MESSAGE));
  }

  const catalogWriter = createCatalogWriteClient();
  const read = await readPendingChanges(catalogWriter, existing.id);
  if (!read.ok) redirect(withQuery(here, "error", SAVE_FAILED_MESSAGE));
  const live = liveValuesOf(existing);
  const base = read.pending ?? live;

  // 3. Everything that needs no review, onto the live book.
  const direct = {
    subtitle: details.subtitle,
    language: details.language,
    series_id: details.seriesId,
    series_position: details.seriesId ? details.seriesPosition : null,
    edition_number: details.editionNumber,
    ...(details.isAdult === existing.is_adult ? { reading_age_min: details.readingAgeMin } : {}),
    categories: details.categories.length > 0 ? details.categories : null,
    keywords: details.keywords.join(", "),
  };
  const { data, error } = await catalogWriter
    .from("books")
    .update(direct)
    .eq("id", existing.id)
    .eq("author_id", userId)
    .eq("status", "published")
    .select("id");
  if (error) {
    console.error("saveBookDetails: live update failed", { bookId: existing.id, code: error.code ?? null });
    if (isInReviewLockError(error)) inReviewPage();
    if (error.code === "LB493") redirect(withQuery(here, "error", LIVE_ADULT_CATEGORY_MESSAGE));
    redirect(withQuery(here, "error", penNameErrorMessage(error) ?? SAVE_FAILED_MESSAGE));
  }
  if (!isExactlyOneRowWritten(data) || data?.[0]?.id !== existing.id) {
    redirect(withQuery(here, "error", LIVE_NOT_LIVE_MESSAGE));
  }

  // 4. The waiting version.
  const wanted: PendingChanges = {
    filePath: base.filePath,
    coverPath: base.coverPath,
    description: details.description,
    isAdult: details.isAdult,
    originalAuthor: details.originalAuthor,
  };
  const waiting = changedPendingFields(live, wanted).length > 0;
  if (!waiting) {
    if (read.pending) {
      const dropped = await discardPendingChanges(catalogWriter, {
        authorId: userId,
        bookId: existing.id,
        expectedVersion: read.version,
      });
      if (!dropped.ok) {
        if (dropped.reason === "in_review") inReviewPage();
        // Audit P5b-2 r2, R2-4: step 3 is already live. P5b-3b: so is a
        // refusal because another save came in between (LB496).
        redirect(withQuery(here, "error", LIVE_PARTLY_SAVED_MESSAGE));
      }
    }
  } else if (!read.pending || changedPendingFields(read.pending, wanted).length > 0) {
    // P5b-3b: refused (LB496) when another save came in after the read
    // above; the author reloads and saves again (Renato 11-05, Q1 a).
    const saved = await savePendingChanges(catalogWriter, {
      authorId: userId,
      bookId: existing.id,
      expectedVersion: read.version,
      changes: wanted,
    });
    if (!saved.ok) {
      if (saved.reason === "in_review") inReviewPage();
      if (saved.reason === "adult_category") redirect(withQuery(here, "error", LIVE_ADULT_CATEGORY_MESSAGE));
      // Audit r1 F5: step 3 is already live; only the waiting part failed.
      redirect(withQuery(here, "error", LIVE_PARTLY_SAVED_MESSAGE));
    }
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/books");
  revalidatePath(`/libra/${existing.id}`);

  // 5. Contributors.
  if (!(await syncContributors(supabase, existing.id, details.contributors))) {
    if (await isWaitingForReview(supabase, existing.id)) inReviewPage();
    redirect(withQuery(here, "error", CONTRIBUTORS_NOT_SAVED_MESSAGE));
  }
  // An older live book with no rights record keeps own rights (the only
  // basis LB492 allows it); recorded only when it was chosen.
  if (rights.kind === "none" && details.rightsBasis === "own_rights") {
    const recorded = await recordRightsDeclaration(existing.id, "own_rights");
    if (!recorded.ok) {
      console.error("saveBookDetails: rights declaration not recorded", { bookId: existing.id, reason: recorded.reason });
      redirect(withQuery(here, "error", RIGHTS_NOT_SAVED_MESSAGE));
    }
  }

  const next = editorPath(existing.id, String(formData.get("intent") ?? "") === "next" ? "content" : "details");
  redirect(withQuery(next, "success", waiting ? LIVE_SAVED_PENDING_MESSAGE : LIVE_SAVED_MESSAGE));
}

// BD15 P5b-2: "Hidhni ndryshimet" -- a live book's waiting changes are
// dropped (not while they are in review: LB490) and the files only they
// named are removed: a waiting ballinë that is not the live one, and the
// waiting manuscript unless the retention rule still keeps it.
export async function discardBookPendingChanges(bookId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }
  const existing = await readOwnBook(supabase, user.id, bookId);
  if (!existing) {
    redirect("/dashboard");
  }
  const here = editorPath(existing.id, "details");
  const catalogWriter = createCatalogWriteClient();
  const read = await readPendingChanges(catalogWriter, existing.id);
  if (!read.ok) redirect(withQuery(here, "error", SAVE_FAILED_MESSAGE));
  // P5b-3b: only the waiting changes read above are discarded; a newer
  // save from another tab is refused here (LB496) and its files stay.
  const dropped = await discardPendingChanges(catalogWriter, {
    authorId: user.id,
    bookId: existing.id,
    expectedVersion: read.version,
  });
  if (!dropped.ok) {
    if (dropped.reason === "in_review") {
      redirect(withQuery(editorPath(existing.id, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));
    }
    if (dropped.reason === "conflict") redirect(withQuery(here, "error", BOOK_CHANGED_WHILE_EDITING_MESSAGE));
    redirect(withQuery(here, "error", SAVE_FAILED_MESSAGE));
  }
  if (!dropped.discarded || !read.pending) {
    redirect(withQuery(here, "success", NO_CHANGES_TO_DISCARD_MESSAGE));
  }

  // Best effort, after the row is gone: an orphaned object is preferable
  // to removing a file anything still names.
  // Audit r1 F3: the cover is removed only when, read AFTER the discard,
  // neither the book (an approval in between may have made it live) nor
  // a new waiting row (another tab) names it. Unreadable: kept.
  const cover = read.pending.coverPath;
  if (cover !== null && cover !== existing.cover_path && isNewBookCoverPath(cover)) {
    const [liveNow, pendingNow] = await Promise.all([
      catalogWriter
        .from("books")
        .select("cover_path")
        .eq("id", existing.id)
        .eq("author_id", user.id)
        .maybeSingle<{ cover_path: string | null }>(),
      readPendingChanges(catalogWriter, existing.id),
    ]);
    const stillNamed =
      liveNow.error !== null ||
      !liveNow.data ||
      liveNow.data.cover_path === cover ||
      !pendingNow.ok ||
      pendingNow.pending?.coverPath === cover;
    if (!stillNamed) {
      const { error } = await catalogWriter.storage.from(BOOK_COVERS_BUCKET).remove([cover]);
      if (error) console.error("discardBookPendingChanges: waiting ballinë not removed", { bookId: existing.id });
    }
  }
  if (read.pending.filePath !== null && read.pending.filePath !== existing.file_path) {
    await removeUnretainedManuscripts(catalogWriter, catalogWriter, {
      authorId: user.id,
      bookId: existing.id,
      superseded: [read.pending.filePath],
      caller: "discardBookPendingChanges",
    });
  }

  revalidatePath("/dashboard");
  redirect(withQuery(here, "success", CHANGES_DISCARDED_MESSAGE));
}

export async function saveBookDetails(bookId: string | null, formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const here = bookId ? editorPath(bookId, "details") : "/dashboard/books/new";

  // The browser checks the same rules first (src/lib/book-details.ts),
  // so this refusal is for a form that skipped them.
  const parsed = parseBookDetails(formData);
  if (!parsed.ok) {
    redirect(withQuery(here, "error", DETAILS_INVALID_MESSAGE));
  }
  const details = parsed.details;

  let existing: ExistingBook | null = null;
  if (bookId) {
    existing = await readOwnBook(supabase, user.id, bookId);
    if (!existing) {
      redirect("/dashboard");
    }
    // BD15 P5b-3a: a book in review shows read-only in the editor; an
    // unreadable review state saves nothing. (books.status is only ever
    // draft or published.)
    if (existing.status !== "draft" && existing.status !== "published") {
      redirect("/dashboard");
    }
    const review = await getBookReviewState(supabase, existing.id);
    if (review.kind !== "ok") {
      redirect(withQuery(editorPath(existing.id, "details"), "error", SAVE_FAILED_MESSAGE));
    }
    if (review.pending) {
      redirect(withQuery(editorPath(existing.id, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));
    }
  }
  if (existing && existing.status === "published") {
    await saveLiveBookDetails(supabase, user.id, existing, details, formData);
  }

  // N1 and the title lock (migration 20261103200000, LB480/LB481): once a
  // book has been published its title and pen name never change. The
  // form doesn't offer them then; anything submitted is ignored.
  const locked = existing !== null && existing.published_at !== null;
  const title = locked ? existing!.title : details.title;

  let penNameId: string;
  if (locked) {
    penNameId = existing!.pen_name_id;
  } else if (details.penNameId) {
    if (!(await ownsPenName(supabase, user.id, details.penNameId))) {
      redirect(withQuery(here, "error", DETAILS_INVALID_MESSAGE));
    }
    penNameId = details.penNameId;
  } else if (existing) {
    penNameId = existing.pen_name_id;
  } else {
    // A new book with no choice: the author's default pen name.
    const resolved = await resolveOwnPenNameId(user.id, null);
    if (!resolved.ok) {
      redirect(withQuery(here, "error", SAVE_FAILED_MESSAGE));
    }
    penNameId = resolved.penNameId;
  }

  if (details.seriesId && !(await ownsSeries(supabase, user.id, details.seriesId))) {
    redirect(withQuery(here, "error", SERIES_NOT_OWN_MESSAGE));
  }

  const row = {
    title,
    subtitle: details.subtitle,
    language: details.language,
    series_id: details.seriesId,
    series_position: details.seriesId ? details.seriesPosition : null,
    edition_number: details.editionNumber,
    pen_name_id: penNameId,
    description: details.description,
    is_adult: details.isAdult,
    reading_age_min: details.readingAgeMin,
    // An empty list is "none chosen yet" (the column's CHECK wants 1-3);
    // the database keeps genre = categories[1].
    categories: details.categories.length > 0 ? details.categories : null,
    keywords: details.keywords.join(", "),
    original_author: details.originalAuthor,
  };

  // The row is written with the trusted catalog writer; every identifying value is the server's own (the
  // id is generated here or was proven above, the author is the session
  // user), and the update is bound to the caller's own draft.
  const catalogWriter = createCatalogWriteClient();
  let savedId: string;
  if (!existing) {
    savedId = randomUUID();
    // status is left to its default, 'draft' (CATALOG-WRITE-AUTH-1).
    const { data, error } = await catalogWriter
      .from("books")
      .insert({ id: savedId, author_id: user.id, ...row })
      .select("id");
    if (error) {
      console.error("saveBookDetails: insert failed", { code: error.code ?? null });
      redirect(withQuery(here, "error", penNameErrorMessage(error) ?? SAVE_FAILED_MESSAGE));
    }
    if (!isExactlyOneRowWritten(data) || data?.[0]?.id !== savedId) {
      console.error("saveBookDetails: insert did not create exactly this one row");
      redirect(withQuery(here, "error", SAVE_FAILED_MESSAGE));
    }
  } else {
    savedId = existing.id;
    // A locked book's update names neither title nor pen_name_id.
    const payload: Partial<typeof row> = { ...row };
    if (locked) {
      delete payload.title;
      delete payload.pen_name_id;
    }
    const { data, error } = await catalogWriter
      .from("books")
      .update(payload)
      .eq("id", existing.id)
      .eq("author_id", user.id)
      .eq("status", "draft")
      .select("id");
    if (error) {
      console.error("saveBookDetails: update failed", { bookId: existing.id, code: error.code ?? null });
      // BD15 P5a: sent for review from another tab after the check
      // above; the book is read-only now (LB490).
      if (isInReviewLockError(error)) {
        redirect(withQuery(editorPath(existing.id, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));
      }
      redirect(withQuery(here, "error", penNameErrorMessage(error) ?? SAVE_FAILED_MESSAGE));
    }
    if (!isExactlyOneRowWritten(data) || data?.[0]?.id !== existing.id) {
      redirect(withQuery(here, "error", CATALOG_ROW_CHANGED_MESSAGE));
    }
  }

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/books");

  const next = editorPath(savedId, String(formData.get("intent") ?? "") === "next" ? "content" : "details");

  // The book row is saved; a contributor or rights failure below never
  // loses it, it is reported on the page the author lands on.
  if (!(await syncContributors(supabase, savedId, details.contributors))) {
    // Audit r1, F4: sent for review from another tab after the row save.
    if (await isWaitingForReview(supabase, savedId)) {
      redirect(withQuery(editorPath(savedId, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));
    }
    redirect(withQuery(editorPath(savedId, "details"), "error", CONTRIBUTORS_NOT_SAVED_MESSAGE));
  }

  if (details.rightsBasis) {
    const current = existing ? await getRightsDeclarationState(savedId) : { kind: "none" as const };
    const unchanged = current.kind === "present" && current.declaration.basis === details.rightsBasis;
    if (!unchanged) {
      const recorded = await recordRightsDeclaration(savedId, details.rightsBasis);
      if (!recorded.ok) {
        console.error("saveBookDetails: rights declaration not recorded", { bookId: savedId, reason: recorded.reason });
        if (await isWaitingForReview(supabase, savedId)) {
          redirect(withQuery(editorPath(savedId, "details"), "error", IN_REVIEW_LOCKED_MESSAGE));
        }
        redirect(withQuery(editorPath(savedId, "details"), "error", RIGHTS_NOT_SAVED_MESSAGE));
      }
    }
  }

  redirect(withQuery(next, "success", DETAILS_SAVED_MESSAGE));
}

export type CreateSeriesResult =
  | { ok: true; series: { id: string; title: string; pen_name_id: string } }
  | { ok: false; message: string };

// "+ Krijo seri të re" inside the editor: the series is made under the
// pen name chosen in the editor and returned, so the editor can select it
// without losing what the author has typed. Same rules as createSeries
// (dashboard/series/actions.ts).
export async function createSeriesFromEditor(rawTitle: unknown, rawPenNameId: unknown): Promise<CreateSeriesResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: SAVE_FAILED_MESSAGE };

  const title = (typeof rawTitle === "string" ? rawTitle : "").replace(/\s+/g, " ").trim();
  if (!title || Array.from(title).length > 300) {
    return { ok: false, message: "Shkruani titullin e serisë (deri në 300 karaktere)." };
  }
  const penNameId = typeof rawPenNameId === "string" ? rawPenNameId : "";
  if (!(await ownsPenName(supabase, user.id, penNameId))) {
    return { ok: false, message: "Zgjidhni një nga emrat tuaj të autorit." };
  }

  const { data, error } = await supabase
    .from("series")
    .insert({ author_id: user.id, title, pen_name_id: penNameId })
    .select("id, title, pen_name_id")
    .single<{ id: string; title: string; pen_name_id: string }>();
  if (error || !data) {
    console.error("createSeriesFromEditor: insert failed", { code: error?.code ?? null });
    return { ok: false, message: "Seria nuk u krijua dot. Provoni përsëri." };
  }
  revalidatePath("/dashboard/series");
  return { ok: true, series: data };
}
