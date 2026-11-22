"use server";

import { createClient as createSupabaseClient, type SupabaseClient } from "@supabase/supabase-js";
import { requireStaff } from "@/lib/staff";
import { assertSupabaseEnvSafeForExecution } from "@/lib/supabase/env-guard";
import { cleanLinkSearchTerm, foldForSearch } from "@/lib/blog-links";
import { LISTED_BOOK_STATUSES } from "@/lib/preorder-reader";
import { bookPagePath } from "@/lib/seo";
import { authorPagePath } from "@/lib/pen-names";

// Blog editor link search (Renato 2026-11-22, lk1 c, lk2 a, lk4 a):
// the 🔗 box finds Librum pages to link to.
//
// lk2 a: only what any visitor can already open. So every read below
// uses the PUBLIC (anon) key with no signed-in session, never the
// staff member's own session (as an author, staff would otherwise see
// their own drafts and pen names) and never the service role:
// - books: search_books() (published + pre-order, lk4 a, with a price,
//   exactly the bookstore's list);
// - authors: public_pen_names as a visitor sees it (only pen names with
//   a public book; never suspended or deleting accounts);
// - articles: search_blog_posts() (published and already live only).
// The action itself is staff-only (blog.manage), so it is not a new
// public search.

export type LinkSearchHit = {
  kind: "book" | "author" | "post";
  href: string;
  title: string;
  subtitle: string;
  imageUrl: string | null;
};

export type LinkSearchResult = { ok: true; hits: LinkSearchHit[] } | { ok: false };

const LINK_SEARCH_LIMITS = { book: 5, author: 3, post: 3 } as const;
const PEN_NAME_SCAN_LIMIT = 1000;

function anonClient(): SupabaseClient {
  assertSupabaseEnvSafeForExecution();
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// Titles that start with the words come first, then titles that
// contain them, then the rest (found by author or keywords), A to Z.
function rank(text: string, folded: string): number {
  const t = foldForSearch(text);
  return t.startsWith(folded) ? 0 : t.includes(folded) ? 1 : 2;
}

function byMatch<T>(rows: T[], text: (row: T) => string, folded: string): T[] {
  return [...rows].sort(
    (a, b) => rank(text(a), folded) - rank(text(b), folded) || text(a).localeCompare(text(b), "sq"),
  );
}

type BookRow = { id: string; title: string; cover_path: string | null; pen: { name: string } | null };
type PenRow = { id: string; name: string };
type PostRow = { id: string; title: string; slug: string };

async function findBooks(supabase: SupabaseClient, term: string, folded: string): Promise<LinkSearchHit[]> {
  const { data: matches, error } = await supabase.rpc("search_books", {
    search_term: term,
    genre_filter: null,
    min_price_cents: null,
    max_price_cents: null,
    result_limit: 50,
  });
  if (error) throw new Error(`search_books: ${error.code ?? "error"}`);
  const ids = ((matches as { book_id: string }[] | null) ?? []).map((m) => m.book_id);
  if (ids.length === 0) return [];
  const { data, error: readError } = await supabase
    .from("public_books")
    .select("id, title, cover_path, pen:public_pen_names(name)")
    .in("id", ids)
    .in("status", LISTED_BOOK_STATUSES)
    .not("price_all", "is", null)
    .returns<BookRow[]>();
  if (readError) throw new Error(`public_books: ${readError.code ?? "error"}`);
  return byMatch(data ?? [], (b) => b.title, folded)
    .slice(0, LINK_SEARCH_LIMITS.book)
    .map((b) => ({
      kind: "book",
      href: bookPagePath(b.id),
      title: b.title,
      subtitle: b.pen?.name ? `${b.pen.name} · libër` : "libër",
      imageUrl: b.cover_path ? supabase.storage.from("covers").getPublicUrl(b.cover_path).data.publicUrl : null,
    }));
}

// Pen names are few; they are matched here, accent-blind, because the
// view has no search function of its own.
async function findAuthors(supabase: SupabaseClient, folded: string): Promise<LinkSearchHit[]> {
  const { data, error } = await supabase
    .from("public_pen_names")
    .select("id, name")
    .order("id")
    .limit(PEN_NAME_SCAN_LIMIT)
    .returns<PenRow[]>();
  if (error) throw new Error(`public_pen_names: ${error.code ?? "error"}`);
  return byMatch(
    (data ?? []).filter((p) => foldForSearch(p.name).includes(folded)),
    (p) => p.name,
    folded,
  )
    .slice(0, LINK_SEARCH_LIMITS.author)
    .map((p) => ({ kind: "author", href: authorPagePath(p.id), title: p.name, subtitle: "faqja e autorit", imageUrl: null }));
}

async function findPosts(supabase: SupabaseClient, term: string): Promise<LinkSearchHit[]> {
  const { data: matches, error } = await supabase.rpc("search_blog_posts", {
    search_term: term,
    result_limit: LINK_SEARCH_LIMITS.post,
  });
  if (error) throw new Error(`search_blog_posts: ${error.code ?? "error"}`);
  const ids = ((matches as { post_id: string }[] | null) ?? []).map((m) => m.post_id);
  if (ids.length === 0) return [];
  const { data, error: readError } = await supabase
    .from("blog_posts")
    .select("id, title, slug")
    .in("id", ids)
    .eq("status", "published")
    .returns<PostRow[]>();
  if (readError) throw new Error(`blog_posts: ${readError.code ?? "error"}`);
  const rows = new Map((data ?? []).map((p) => [p.id, p]));
  return ids
    .slice(0, LINK_SEARCH_LIMITS.post)
    .map((id) => rows.get(id))
    .filter((p): p is PostRow => Boolean(p))
    .map((p) => ({
      kind: "post",
      href: `/blog/${encodeURIComponent(p.slug)}`,
      title: p.title,
      subtitle: "artikull në blog",
      imageUrl: null,
    }));
}

export async function searchBlogLinkTargets(raw: string): Promise<LinkSearchResult> {
  await requireStaff("blog.manage");
  const term = cleanLinkSearchTerm(typeof raw === "string" ? raw : "");
  if (!term) return { ok: true, hits: [] };
  const folded = foldForSearch(term);
  try {
    const supabase = anonClient();
    const [books, authors, posts] = await Promise.all([
      findBooks(supabase, term, folded),
      findAuthors(supabase, folded),
      findPosts(supabase, term),
    ]);
    return { ok: true, hits: [...books, ...authors, ...posts] };
  } catch (error) {
    console.error("Blog link search failed:", error instanceof Error ? error.message : "unknown");
    return { ok: false };
  }
}
