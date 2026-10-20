import "server-only";
import type { createClient } from "@/lib/supabase/server";
import { AUTHOR_TAKEDOWN_COLUMNS, type AuthorTakedown, type AuthorTakedownNotice } from "@/lib/takedown-reasons";

// ADMIN-2-TAKEDOWN: the author-side reads of public.book_takedowns
// (migration 20261020080000), always with the AUTHOR'S OWN session
// client: RLS shows an author only their own rows, and authenticated
// holds SELECT on AUTHOR_TAKEDOWN_COLUMNS only (never `*`, never `id`).

type SessionClient = Awaited<ReturnType<typeof createClient>>;

// The publish and delete gates' three-way read of one book's ACTIVE
// takedown. `unavailable` (before the migration, or any read error)
// makes both gates refuse: they fail closed, never mistaking "we
// couldn't tell" for "not taken down".
export type ActiveTakedownState =
  | { kind: "none" }
  | { kind: "active"; takedown: AuthorTakedown }
  | { kind: "unavailable" };

export async function getActiveTakedownState(
  supabase: SessionClient,
  bookId: string,
): Promise<ActiveTakedownState> {
  const { data, error } = await supabase
    .from("book_takedowns")
    .select(AUTHOR_TAKEDOWN_COLUMNS)
    .eq("book_id", bookId)
    .is("lifted_at", null)
    .maybeSingle<AuthorTakedown>();
  if (error) {
    console.error("getActiveTakedownState: read failed", { bookId, error });
    return { kind: "unavailable" };
  }
  return data ? { kind: "active", takedown: data } : { kind: "none" };
}

// The Dashboard's notices: every active takedown of this author's books,
// keyed by book id, with the titles of the bundles each one unpublished
// (read with the same session: the author's own bundles). Display only,
// so a failed read shows no notice (logged) -- the publish gate above
// still refuses on its own.
export async function loadAuthorTakedownNotices(
  supabase: SessionClient,
  authorId: string,
): Promise<Map<string, AuthorTakedownNotice>> {
  const notices = new Map<string, AuthorTakedownNotice>();

  const { data: takedowns, error } = await supabase
    .from("book_takedowns")
    .select(AUTHOR_TAKEDOWN_COLUMNS)
    .eq("author_id", authorId)
    .is("lifted_at", null)
    .returns<AuthorTakedown[]>();
  if (error) {
    console.error("loadAuthorTakedownNotices: read failed", { error });
    return notices;
  }
  const active = (takedowns ?? []).filter((t): t is AuthorTakedown & { book_id: string } => t.book_id !== null);
  if (active.length === 0) return notices;

  const titleById = await readBundleTitles(
    supabase,
    active.flatMap((t) => t.bundle_ids ?? []),
    "loadAuthorTakedownNotices",
  );

  for (const t of active) {
    notices.set(t.book_id, {
      takenDownAt: t.taken_down_at,
      reason: t.reason,
      message: t.message_to_author,
      bundleTitles: titlesFor(t, titleById),
    });
  }
  return notices;
}

// The Edit page: the gate's own three-way state for one book, plus the
// notice when it is active.
export async function loadAuthorTakedownNoticeForBook(
  supabase: SessionClient,
  bookId: string,
): Promise<{ state: ActiveTakedownState; notice: AuthorTakedownNotice | null }> {
  const state = await getActiveTakedownState(supabase, bookId);
  if (state.kind !== "active") return { state, notice: null };
  const titleById = await readBundleTitles(supabase, state.takedown.bundle_ids ?? [], "loadAuthorTakedownNoticeForBook");
  return {
    state,
    notice: {
      takenDownAt: state.takedown.taken_down_at,
      reason: state.takedown.reason,
      message: state.takedown.message_to_author,
      bundleTitles: titlesFor(state.takedown, titleById),
    },
  };
}

async function readBundleTitles(
  supabase: SessionClient,
  ids: string[],
  caller: string,
): Promise<Map<string, string>> {
  const titleById = new Map<string, string>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return titleById;
  // PEN-NAMES-2: through public_bundles (no account column), as every
  // read under src/lib does. It shows published bundles and the caller's
  // own drafts -- the bundles a takedown drafted belong to this author.
  const { data, error } = await supabase
    .from("public_bundles")
    .select("id, title")
    .in("id", unique)
    .returns<{ id: string; title: string }[]>();
  if (error) console.error(`${caller}: bundle titles read failed`, { error });
  for (const bundle of data ?? []) titleById.set(bundle.id, bundle.title);
  return titleById;
}

function titlesFor(takedown: AuthorTakedown, titleById: Map<string, string>): string[] {
  return (takedown.bundle_ids ?? []).map((id) => titleById.get(id)).filter((title): title is string => !!title);
}
