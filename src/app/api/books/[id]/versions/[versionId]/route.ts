import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import { BOOK_MANUSCRIPTS_BUCKET } from "@/lib/book-storage-path";
import { readEarlierBookFilePath } from "@/lib/book-file-versions";
import { isUuid } from "@/lib/preorder-email-failures";

// FV1 (fv2 a, fv3 a): "Shkarko" on an earlier file in the author's
// Content tab. Only the book's own author, signed in; the row must be
// this book's, already replaced, and the book's own key (checked before
// any Storage call). Hands back a short-lived signed URL (5 minutes),
// like the staff file route. The stored file as it was: no Librum pages
// and no buyer mark (the author's own file). Never cached.

const SIGNED_URL_SECONDS = 300;
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const UNAVAILABLE_MESSAGE = "Ky skedar nuk është i disponueshëm.";

export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { Allow: "GET" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  const { id, versionId } = await params;

  const cookieStore = await cookies();
  if (isRecoverySessionActive(cookieStore)) {
    return NextResponse.json(
      { error: "Përfundoni ndryshimin e fjalëkalimit para se të shkarkoni." },
      { status: 403, headers: NO_STORE },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  const back = (path: string) => {
    const response = NextResponse.redirect(new URL(path, request.url));
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  };
  if (!isUuid(id) || !isUuid(versionId)) return back("/dashboard");
  const unavailable = () =>
    back(`/dashboard/books/${id}/editor?tab=content&error=${encodeURIComponent(UNAVAILABLE_MESSAGE)}`);

  // The author's own book, read with their own session (RLS + author_id).
  const { data: own, error: ownError } = await supabase
    .from("books")
    .select("id")
    .eq("id", id)
    .eq("author_id", user.id)
    .maybeSingle<{ id: string }>();
  if (ownError || !own || own.id !== id) return back("/dashboard");

  const admin = createAdminClient();
  const version = await readEarlierBookFilePath(admin, { id, authorId: user.id }, versionId);
  if (version.kind !== "ok") return unavailable();

  const { data: signed, error: signError } = await admin.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .createSignedUrl(version.filePath, SIGNED_URL_SECONDS, { download: true });
  if (signError || !signed?.signedUrl) return unavailable();

  return back(signed.signedUrl);
}
