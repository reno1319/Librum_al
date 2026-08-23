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

  // LAUNCH-1 P1-7A: user_owns_book() now also excludes a purchase whose
  // payment intent has a dispute at status 'lost' (see migration 035) --
  // routed through this RPC rather than a raw purchases select, since
  // public.payment_disputes is fully closed to the request-scoped
  // client and this SECURITY DEFINER function already encapsulates the
  // complete, correct ownership predicate.
  let owned = book.author_id === user.id;
  if (!owned) {
    const { data: ownsBook } = await supabase.rpc("user_owns_book", {
      target_book_id: id,
    });
    owned = !!ownsBook;
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
