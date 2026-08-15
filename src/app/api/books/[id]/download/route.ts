import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { watermarkEpub } from "@/lib/watermark";

// Manuscripts live in a private storage bucket. Nobody gets a permanent
// link to them — this route checks ownership on every request, then
// streams back a copy watermarked with the downloader's email.
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
      .is("refunded_at", null)
      .maybeSingle();
    owned = !!purchase;
  }

  if (!owned) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=Buy+this+book+to+download+it`, request.url),
    );
  }

  const admin = createAdminClient();
  const { data: fileBlob, error: downloadError } = await admin.storage
    .from("manuscripts")
    .download(book.file_path);

  if (downloadError || !fileBlob) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=Could+not+download+that+file`, request.url),
    );
  }

  const originalBytes = Buffer.from(await fileBlob.arrayBuffer());
  const fileBytes = user.email
    ? await watermarkEpub(originalBytes, user.email)
    : originalBytes;

  const fileName = `${book.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.epub`;

  return new NextResponse(new Uint8Array(fileBytes), {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(fileBytes.length),
    },
  });
}
