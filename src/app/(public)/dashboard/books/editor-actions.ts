"use server";

// BD15 P2: the new book editor's server actions -- the Details tab's
// save (the first save creates the draft), and a series made from
// inside the editor. PLAN-BD15-r1 §2.2 and §2.3.
//
// What this patch does not do yet (later BD15 patches): the manuscript
// and cover (P3), the price and sending for review (P4), editing a
// live book or a book in review (P5: until then those stay on the
// existing edit page, which this action sends them to).

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { resolveOwnPenNameId } from "@/lib/pen-name-write-client";
import { penNameErrorMessage } from "@/lib/pen-names";
import { getRightsDeclarationState, recordRightsDeclaration } from "@/lib/book-rights";
import { getBookReviewState, isInReviewLockError, isWaitingForReview } from "@/lib/book-reviews";
import { IN_REVIEW_LOCKED_MESSAGE } from "@/lib/book-review-copy";
import { CATALOG_ROW_CHANGED_MESSAGE, isExactlyOneRowWritten } from "@/lib/paid-repricing";
import { parseBookDetails, type DetailsContributor } from "@/lib/book-details";
import {
  CONTRIBUTORS_NOT_SAVED_MESSAGE,
  DETAILS_INVALID_MESSAGE,
  DETAILS_SAVED_MESSAGE,
  EDITOR_ONLY_DRAFTS_MESSAGE,
  RIGHTS_NOT_SAVED_MESSAGE,
  SAVE_FAILED_MESSAGE,
  SERIES_NOT_OWN_MESSAGE,
  editorPath,
} from "@/lib/book-editor-copy";

type SessionClient = Awaited<ReturnType<typeof createClient>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The one book row this action may change: the caller's own draft.
type ExistingBook = {
  id: string;
  author_id: string;
  status: string;
  published_at: string | null;
  title: string;
  pen_name_id: string;
};

async function readOwnBook(supabase: SessionClient, userId: string, bookId: string): Promise<ExistingBook | null> {
  if (!UUID.test(bookId)) return null;
  const { data, error } = await supabase
    .from("books")
    .select("id, author_id, status, published_at, title, pen_name_id")
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
// author's own session, the same RLS path addContributor uses.
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
    // Until P5, a live book and a book in review are edited on the
    // existing edit page, which knows their review rules.
    if (existing.status !== "draft") {
      redirect(withQuery(`/dashboard/books/${existing.id}/edit`, "error", EDITOR_ONLY_DRAFTS_MESSAGE));
    }
    const review = await getBookReviewState(supabase, existing.id);
    if (review.kind !== "ok" || review.pending) {
      redirect(withQuery(`/dashboard/books/${existing.id}/edit`, "error", EDITOR_ONLY_DRAFTS_MESSAGE));
    }
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

  // The row is written with the trusted catalog writer, as createBook
  // and updateBook do; every identifying value is the server's own (the
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
        redirect(withQuery(`/dashboard/books/${existing.id}/edit`, "error", IN_REVIEW_LOCKED_MESSAGE));
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
      redirect(withQuery(`/dashboard/books/${savedId}/edit`, "error", IN_REVIEW_LOCKED_MESSAGE));
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
          redirect(withQuery(`/dashboard/books/${savedId}/edit`, "error", IN_REVIEW_LOCKED_MESSAGE));
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
