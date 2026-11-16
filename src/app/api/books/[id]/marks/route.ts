import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import { parseMarksOp, toMarkHighlights, type MarksData } from "@/lib/reader-marks";

// K8 + K10 (Renato 11-15): a buyer's reading place, bookmarks and
// highlights for one book, for the online reader.
//   GET  -> { place, bookmarks, highlights }
//   POST -> one change (see parseMarksOp in src/lib/reader-marks.ts)
// Q4 a: buyers only, inside books they own. Every read and write runs as
// the signed-in reader (never the service key), so the database's own
// rules decide too: only the reader's own rows, only while they own the
// book (user_owns_book: a refund or a lost dispute ends it). The
// explicit ownership check first gives the reader a clear 403 (and the
// book's author, who doesn't own it, gets no marking).
// POST takes JSON only and refuses another site's Origin (the session
// cookie is SameSite=Lax as well). Never stored by a shared cache.

const NO_STORE = { "Cache-Control": "private, no-store" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function done(body: unknown) {
  return NextResponse.json(body, { headers: NO_STORE });
}

type Gate = { ok: true; supabase: Awaited<ReturnType<typeof createClient>> } | { ok: false; res: NextResponse };

async function gate(id: string): Promise<Gate> {
  if (!UUID.test(id)) return { ok: false, res: fail(404, "not_found") };
  const cookieStore = await cookies();
  if (isRecoverySessionActive(cookieStore)) return { ok: false, res: fail(403, "recovery_session") };
  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData?.user) return { ok: false, res: fail(401, "sign_in") };
  const { data: owns, error: ownsError } = await supabase.rpc("user_owns_book", { target_book_id: id });
  if (ownsError) return { ok: false, res: fail(503, "unavailable") };
  if (owns !== true) return { ok: false, res: fail(403, "not_owned") };
  return { ok: true, supabase };
}

export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { Allow: "GET, POST" } });
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const g = await gate(id);
  if (!g.ok) return g.res;
  const { supabase } = g;

  const [placeRes, bookmarksRes, highlightsRes] = await Promise.all([
    supabase.from("reading_places").select("char_offset, progress, updated_at").eq("book_id", id).maybeSingle(),
    supabase.from("reader_bookmarks").select("id, char_offset").eq("book_id", id).order("char_offset"),
    supabase
      .from("reader_highlights")
      .select("id, start_offset, end_offset, quote, prefix, suffix, color, note, orphaned_at")
      .eq("book_id", id)
      .order("start_offset"),
  ]);
  if (placeRes.error || bookmarksRes.error || highlightsRes.error) return fail(503, "unavailable");

  const p = placeRes.data as { char_offset: number; progress: number | string; updated_at: string } | null;
  const body: MarksData = {
    place: p ? { offset: p.char_offset, progress: Number(p.progress), updatedAt: p.updated_at } : null,
    bookmarks: ((bookmarksRes.data ?? []) as { id: string; char_offset: number }[]).map((b) => ({ id: b.id, offset: b.char_offset })),
    highlights: toMarkHighlights(highlightsRes.data),
  };
  return done(body);
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "json_only");
  if (!sameOrigin(request)) return fail(403, "origin");
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail(400, "bad_request");
  }
  const op = parseMarksOp(raw);
  if (!op) return fail(400, "bad_request");

  const g = await gate(id);
  if (!g.ok) return g.res;
  const { supabase } = g;
  const now = new Date().toISOString();

  // 23514 'reader_marks_limit' (the per-book limits) reads as 409 limit.
  const limitOr503 = (error: { code?: string; message?: string }) =>
    error.code === "23514" && (error.message ?? "").includes("reader_marks_limit") ? fail(409, "limit") : fail(503, "unavailable");

  switch (op.op) {
    case "place": {
      // Update, else insert (an upsert would also try to update book_id,
      // which readers may not change); a parallel insert that won makes
      // the second try an update.
      const row = { char_offset: op.offset, progress: op.progress, updated_at: now };
      for (let attempt = 0; attempt < 2; attempt++) {
        const upd = await supabase.from("reading_places").update(row).eq("book_id", id).select("updated_at");
        if (upd.error) return fail(503, "unavailable");
        const updated = upd.data as { updated_at: string }[] | null;
        if (updated && updated.length === 1) return done({ updatedAt: updated[0].updated_at });
        const ins = await supabase.from("reading_places").insert({ book_id: id, ...row }).select("updated_at").single();
        if (!ins.error && ins.data) return done({ updatedAt: (ins.data as { updated_at: string }).updated_at });
        if (ins.error?.code !== "23505") return fail(503, "unavailable");
      }
      return fail(503, "unavailable");
    }
    case "bookmark_add": {
      const { data, error } = await supabase.from("reader_bookmarks").insert({ book_id: id, char_offset: op.offset }).select("id").single();
      if (error?.code === "23505") {
        const { data: existing } = await supabase
          .from("reader_bookmarks")
          .select("id")
          .eq("book_id", id)
          .eq("char_offset", op.offset)
          .maybeSingle();
        if (existing) return done({ id: (existing as { id: string }).id });
      }
      if (error || !data) return error ? limitOr503(error) : fail(503, "unavailable");
      return done({ id: (data as { id: string }).id });
    }
    case "bookmark_remove": {
      const { error } = await supabase.from("reader_bookmarks").delete().eq("book_id", id).in("id", op.ids);
      return error ? fail(503, "unavailable") : done({ ok: true });
    }
    case "highlight_add": {
      const { data, error } = await supabase
        .from("reader_highlights")
        .insert({
          book_id: id,
          start_offset: op.start,
          end_offset: op.end,
          quote: op.quote,
          prefix: op.prefix,
          suffix: op.suffix,
          color: op.color,
          note: op.note,
        })
        .select("id")
        .single();
      if (error || !data) return error ? limitOr503(error) : fail(503, "unavailable");
      return done({ id: (data as { id: string }).id });
    }
    case "highlight_update": {
      const patch: Record<string, unknown> = { updated_at: now };
      if (op.color !== undefined) patch.color = op.color;
      if (op.note !== undefined) patch.note = op.note;
      const { data, error } = await supabase.from("reader_highlights").update(patch).eq("book_id", id).eq("id", op.id).select("id");
      if (error) return fail(503, "unavailable");
      return Array.isArray(data) && data.length === 1 ? done({ ok: true }) : fail(404, "not_found");
    }
    case "highlight_remove": {
      const { error } = await supabase.from("reader_highlights").delete().eq("book_id", id).eq("id", op.id);
      return error ? fail(503, "unavailable") : done({ ok: true });
    }
    case "reanchor": {
      // One call: found highlights move (orphaned_at cleared), the
      // not-found ones are marked once (Q3 a: never deleted).
      const { error } = await supabase.rpc("reader_highlights_reanchor", {
        p_book_id: id,
        p_moves: op.moves.map((m) => ({ id: m.id, start_offset: m.start, end_offset: m.end })),
        p_orphaned: op.orphaned,
      });
      return error ? fail(503, "unavailable") : done({ ok: true });
    }
  }
}
