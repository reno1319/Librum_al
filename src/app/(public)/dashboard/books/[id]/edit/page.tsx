import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { editorPath } from "@/lib/book-editor-copy";

// BD15 P5b-3a: the old edit page is retired. Everything it did -- a book
// in review (read-only, "Anuloni shqyrtimin"), a taken-down book, taking
// a live book off sale, deleting a book -- now happens in the book
// editor. This route stays only so old links and bookmarks still land
// on the right book; the editor checks the session and ownership itself.
export const metadata: Metadata = {
  title: "Redaktori i librit",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditBookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  redirect(editorPath(id, "details"));
}
