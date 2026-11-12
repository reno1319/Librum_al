// BD15 P6: the author's bookshelf on /dashboard (PLAN-BD15-r1 §2.1;
// Renato 11-05: Q1 a -- one shelf, on the Dashboard; Q2 a -- "Më të
// rejat" instead of "last changed", because books.updated_at is never
// written; Q3 a -- no Delete on a live book). Pure and client-safe: the
// page decides each book's state from reads it already made, and the
// card, the filter and the tests all read the same table below.
import type { AuthorReviewNotice } from "@/lib/book-review-copy";

export type ShelfState =
  | "draft"
  | "in_review"
  | "sent_back"
  | "live"
  | "live_changes"
  | "live_in_review"
  | "live_sent_back"
  // BD16 P2: a live pre-order, the same four ways as a live book.
  | "preorder"
  | "preorder_changes"
  | "preorder_in_review"
  | "preorder_sent_back"
  | "taken_down";

export type ShelfBook = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  published_at: string | null;
  series_id: string | null;
  series_position: number | null;
};

/** What the page knows about one book beyond its row. */
export type ShelfFacts = {
  takenDown: boolean;
  review: AuthorReviewNotice | null;
  /** A live book has saved changes readers don't see yet. */
  hasPendingChanges: boolean;
  /** The newest send back is about those waiting changes (as the editor). */
  pendingSentBack: boolean;
};

// A takedown outranks a review (as the editor and the old row did).
// A live book's send back counts only while the changes it was about are
// still waiting (the editor's P5b-3a rule); otherwise the book is simply
// live, or live with newer waiting changes.
export function resolveShelfState(book: Pick<ShelfBook, "status">, facts: ShelfFacts): ShelfState {
  if (facts.takenDown) return "taken_down";
  if (book.status === "preorder") {
    if (facts.review?.inReview) return "preorder_in_review";
    if (facts.hasPendingChanges && facts.review?.sentBack && facts.pendingSentBack) return "preorder_sent_back";
    if (facts.hasPendingChanges) return "preorder_changes";
    return "preorder";
  }
  const live = book.status === "published";
  if (!live) {
    if (facts.review?.inReview) return "in_review";
    if (facts.review?.sentBack) return "sent_back";
    return "draft";
  }
  if (facts.review?.inReview) return "live_in_review";
  if (facts.hasPendingChanges && facts.review?.sentBack && facts.pendingSentBack) return "live_sent_back";
  if (facts.hasPendingChanges) return "live_changes";
  return "live";
}

// BD16 P2: "content" -- a pre-order's next step is its final manuscript.
export type ShelfMainAction = "editor" | "content" | "book_page";

export type ShelfStateCopy = {
  /** The status line on the card. */
  label: string;
  /** One extra line under it, if any. */
  line: string | null;
  /** The one main button. */
  button: string;
  /** Where it goes: the editor, or the public book page. */
  action: ShelfMainAction;
};

export const PREORDER_CHANGES_LINE = "Dërgojini për shqyrtim te Çmimi.";

export const READERS_SEE_OLD_VERSION_LINE =
  "Lexuesit shohin ende versionin e vjetër derisa ndryshimet të miratohen.";

export const SHELF_STATE_COPY: Record<ShelfState, ShelfStateCopy> = {
  draft: { label: "Draft", line: null, button: "Vazhdoni përgatitjen", action: "editor" },
  in_review: {
    label: "Në shqyrtim",
    line: null,
    button: "Shikoni çfarë dërguat",
    action: "editor",
  },
  sent_back: {
    label: "Kthyer për ndryshime",
    line: null,
    button: "Rregullojeni dhe ridërgojeni",
    action: "editor",
  },
  live: { label: "Publikuar", line: null, button: "Shikoni faqen e librit", action: "book_page" },
  live_changes: {
    label: "Publikuar, me ndryshime të padërguara",
    line: READERS_SEE_OLD_VERSION_LINE,
    button: "Vazhdoni ndryshimet",
    action: "editor",
  },
  live_in_review: {
    label: "Publikuar, ndryshimet në shqyrtim",
    line: READERS_SEE_OLD_VERSION_LINE,
    button: "Shikoni çfarë dërguat",
    action: "editor",
  },
  live_sent_back: {
    label: "Publikuar, ndryshimet u kthyen",
    line: READERS_SEE_OLD_VERSION_LINE,
    button: "Rregulloni ndryshimet",
    action: "editor",
  },
  // BD16 P2: the release date, the file due date and the waiting
  // readers are added by the card (author-book-row.tsx).
  preorder: {
    label: "Parapublikim",
    line: null,
    button: "Ngarkoni dorëshkrimin final",
    action: "content",
  },
  preorder_changes: {
    label: "Parapublikim, me ndryshime të padërguara",
    line: PREORDER_CHANGES_LINE,
    button: "Vazhdoni ndryshimet",
    action: "editor",
  },
  preorder_in_review: {
    label: "Parapublikim, në shqyrtim",
    line: null,
    button: "Shikoni çfarë dërguat",
    action: "editor",
  },
  preorder_sent_back: {
    label: "Parapublikim, ndryshimet u kthyen",
    line: null,
    button: "Rregulloni ndryshimet",
    action: "editor",
  },
  taken_down: { label: "Hequr nga Libraria", line: null, button: "Shikoni arsyen", action: "editor" },
};

/** BD16 P2: a pre-order whose final manuscript is approved waits for its day. */
export const PREORDER_READY_COPY: ShelfStateCopy = {
  label: "Parapublikim, gati për daljen",
  line: null,
  button: "Shikoni faqen e librit",
  action: "book_page",
};

/** The copy for a card: a ready pre-order (approved file) has its own. */
export function shelfStateCopy(state: ShelfState, book: { status: string; file_path?: string | null }): ShelfStateCopy {
  if (state === "preorder" && book.status === "preorder" && book.file_path) return PREORDER_READY_COPY;
  return SHELF_STATE_COPY[state];
}

export function isPreorderState(state: ShelfState): boolean {
  return state.startsWith("preorder");
}

export function isLiveState(state: ShelfState): boolean {
  return state.startsWith("live");
}

export function isInReviewState(state: ShelfState): boolean {
  return state === "in_review" || state === "live_in_review" || state === "preorder_in_review";
}

// ------------------------------------------------------------
// The "…" menu: only what applies to the state (plan §2.1).
// ------------------------------------------------------------

export type ShelfMenuItem =
  | "view_page"
  | "preview_page"
  | "edit_details"
  | "edit_content"
  | "edit_price"
  | "series"
  | "download_file"
  | "discard_changes"
  | "unpublish"
  // BD16 P2: in the editor's Veprime box, with its confirmation.
  | "cancel_preorder"
  | "delete";

export function shelfMenuItems(params: {
  state: ShelfState;
  status: string;
  hasFile: boolean;
  /** BD15 P7 (Q1 a): the book is its public-domain work's picked edition. */
  pdPicked?: boolean;
}): ShelfMenuItem[] {
  const { state } = params;
  const live = params.status === "published";
  // BD16 P2: a pre-order's page is public too; it is never deleted or
  // taken off sale, only cancelled (LB507).
  const preorder = params.status === "preorder";
  const listed = live || preorder;
  const items: ShelfMenuItem[] = [];
  // The book page is a live book's main button; before it is live, the
  // book's own page is the author's preview of it (PREVIEW-1).
  if (listed && SHELF_STATE_COPY[state].action !== "book_page") items.push("view_page");
  if (!listed) items.push("preview_page");
  // A book waiting for review is read-only (BD15 P5a).
  if (!isInReviewState(state)) {
    items.push("edit_details", "edit_content", "edit_price");
    // A picked edition's series is frozen (LB497).
    if (!params.pdPicked) items.push("series");
  }
  if (params.hasFile) items.push("download_file");
  if (["live_changes", "live_sent_back", "preorder_changes", "preorder_sent_back"].includes(state)) {
    items.push("discard_changes");
  }
  // A picked edition can't be unpublished by its author (LB483).
  if (live && !params.pdPicked) items.push("unpublish");
  if (preorder && state !== "taken_down") items.push("cancel_preorder");
  // Q3 a: never on a live book -- unpublish first, then it is a draft.
  // Audit P6 r1 N2: never on a taken-down book either -- the editor hides
  // it and deleteBook refuses it.
  if (!listed && state !== "taken_down") items.push("delete");
  return items;
}

// ------------------------------------------------------------
// Toolbar: sort, filter, view, search -- plain URL params.
// ------------------------------------------------------------

export const SHELF_SORTS = [
  { value: "new", label: "Më të rejat" },
  { value: "az", label: "Titulli A–Z" },
  { value: "pub", label: "Data e publikimit" },
] as const;
export type ShelfSort = (typeof SHELF_SORTS)[number]["value"];

export const SHELF_FILTERS = [
  { value: "all", label: "Të gjitha", states: null },
  { value: "draft", label: "Draft", states: ["draft"] },
  { value: "review", label: "Në shqyrtim", states: ["in_review", "live_in_review", "preorder_in_review"] },
  { value: "sent_back", label: "Kthyer për ndryshime", states: ["sent_back", "live_sent_back", "preorder_sent_back"] },
  { value: "live", label: "Publikuar", states: ["live", "live_changes", "live_in_review", "live_sent_back"] },
  {
    value: "preorder",
    label: "Parapublikime",
    states: ["preorder", "preorder_changes", "preorder_in_review", "preorder_sent_back"],
  },
  { value: "changes", label: "Me ndryshime të padërguara", states: ["live_changes", "preorder_changes"] },
  { value: "taken_down", label: "Hequr nga Libraria", states: ["taken_down"] },
] as const satisfies readonly { value: string; label: string; states: readonly ShelfState[] | null }[];
export type ShelfFilter = (typeof SHELF_FILTERS)[number]["value"];

export const SHELF_VIEWS = [
  { value: "series", label: "Sipas serive" },
  { value: "flat", label: "Lista e thjeshtë" },
] as const;
export type ShelfView = (typeof SHELF_VIEWS)[number]["value"];

export type ShelfQuery = { sort: ShelfSort; filter: ShelfFilter; view: ShelfView; q: string };

function pick<T extends string>(value: unknown, allowed: readonly { value: T }[], fallback: T): T {
  return allowed.some((option) => option.value === value) ? (value as T) : fallback;
}

/** Unknown values fall back to the defaults; the search is trimmed. */
export function parseShelfQuery(params: { sort?: string; filter?: string; view?: string; q?: string }): ShelfQuery {
  return {
    sort: pick(params.sort, SHELF_SORTS, "new"),
    filter: pick(params.filter, SHELF_FILTERS, "all"),
    view: pick(params.view, SHELF_VIEWS, "series"),
    q: (params.q ?? "").trim().slice(0, 200),
  };
}

export function matchesShelfFilter(state: ShelfState, filter: ShelfFilter): boolean {
  const entry = SHELF_FILTERS.find((option) => option.value === filter);
  if (!entry || entry.states === null) return true;
  return (entry.states as readonly ShelfState[]).includes(state);
}

function time(iso: string | null): number {
  if (iso === null) return -Infinity;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? -Infinity : parsed;
}

/** A new array in the chosen order; ties fall back to the newest first. */
export function sortShelfBooks<T extends ShelfBook>(books: readonly T[], sort: ShelfSort): T[] {
  const newest = (a: T, b: T) => time(b.created_at) - time(a.created_at) || a.id.localeCompare(b.id);
  return [...books].sort((a, b) => {
    if (sort === "az") return a.title.localeCompare(b.title, "sq", { sensitivity: "base" }) || newest(a, b);
    // Never-published books (no date) go last.
    if (sort === "pub") return time(b.published_at) - time(a.published_at) || newest(a, b);
    return newest(a, b);
  });
}

export type ShelfGroup<T> = { seriesId: string | null; seriesTitle: string | null; books: T[] };

// "Sipas serive": one group per series, in the order its first book
// appears in the sorted list, with the books in reading order (position,
// then the sort); then the books outside a series, in the sort's order.
// A book whose series title can't be read is shown outside a series
// rather than under a nameless heading.
export function groupShelfBooks<T extends ShelfBook>(
  sorted: readonly T[],
  view: ShelfView,
  seriesTitles: ReadonlyMap<string, string>,
): ShelfGroup<T>[] {
  if (view === "flat") return sorted.length > 0 ? [{ seriesId: null, seriesTitle: null, books: [...sorted] }] : [];
  const bySeries = new Map<string, T[]>();
  const loose: T[] = [];
  for (const book of sorted) {
    const title = book.series_id ? seriesTitles.get(book.series_id) : undefined;
    if (book.series_id && title !== undefined) {
      const list = bySeries.get(book.series_id) ?? [];
      list.push(book);
      bySeries.set(book.series_id, list);
    } else {
      loose.push(book);
    }
  }
  const groups: ShelfGroup<T>[] = [];
  for (const [seriesId, list] of bySeries) {
    const order = new Map(list.map((book, index) => [book.id, index]));
    const books = [...list].sort(
      (a, b) =>
        (a.series_position ?? Infinity) - (b.series_position ?? Infinity) ||
        (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0),
    );
    groups.push({ seriesId, seriesTitle: seriesTitles.get(seriesId) ?? null, books });
  }
  if (loose.length > 0) groups.push({ seriesId: null, seriesTitle: null, books: loose });
  return groups;
}

export function shelfHref(query: ShelfQuery): string {
  const params = new URLSearchParams();
  if (query.sort !== "new") params.set("sort", query.sort);
  if (query.filter !== "all") params.set("filter", query.filter);
  if (query.view !== "series") params.set("view", query.view);
  if (query.q) params.set("q", query.q);
  const search = params.toString();
  return search ? `/dashboard?${search}` : "/dashboard";
}
