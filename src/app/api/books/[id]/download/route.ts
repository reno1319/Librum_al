import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Manuscripts live in a private storage bucket. Nobody gets a permanent
// link to them — this route checks ownership on every request, then
// mints a signed URL that expires almost immediately.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL(`/login?next=/books/${id}`, request.url));
  }

  const { data: book } = await supabase
    .from("books")
    .select("file_path, title, author_id")
    .eq("id", id)
    .single();

  if (!book || !book.file_path) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=That+file+isn%27t+available`, request.url),
    );
  }

  let owned = book.author_id === user.id;
  if (!owned) {
    const { data: purchase } = await supabase
      .from("purchases")
      .select("id")
      .eq("book_id", id)
      .eq("reader_id", user.id)
      .maybeSingle();
    owned = !!purchase;
  }

  if (!owned) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=Buy+this+book+to+download+it`, request.url),
    );
  }

  const admin = createAdminClient();
  const fileName = `${book.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.epub`;
  const { data: signed, error } = await admin.storage
    .from("manuscripts")
    .createSignedUrl(book.file_path, 60, { download: fileName });

  if (error || !signed) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=Could+not+create+a+download+link`, request.url),
    );
  }

  return NextResponse.redirect(signed.signedUrl);
}
