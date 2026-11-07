"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { MY_NOTICES_PATH } from "@/lib/preorder-reader";

// BD16 P4 (plan §1 "Më njofto", D8): a signed-in reader asks for one
// email when a pre-order comes out, or removes that request. Both go
// through P1's RPCs (preorder_notify_me / preorder_notify_remove): the
// table has no insert or delete grant for readers, and the RPC refuses
// a book that is not a live pre-order (LB508). Nothing here sends email
// (P5 does, from the job).

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function notifyMeWhenOut(bookId: string) {
  if (!UUID_PATTERN.test(bookId)) redirect("/librari");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=/libra/${bookId}`);
  }

  // false (already on the list) is fine: the reader is on it.
  const { error } = await supabase.rpc("preorder_notify_me", { p_book_id: bookId });
  revalidatePath(`/libra/${bookId}`);
  revalidatePath(MY_NOTICES_PATH);
  redirect(`/libra/${bookId}?notify=${error ? "error" : "on"}`);
}

// from = where the reader pressed "Hiq": the book page or their list.
export async function removePreorderNotice(bookId: string, from: "book" | "list") {
  if (!UUID_PATTERN.test(bookId)) redirect(MY_NOTICES_PATH);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${from === "list" ? MY_NOTICES_PATH : `/libra/${bookId}`}`);
  }

  const { error } = await supabase.rpc("preorder_notify_remove", { p_book_id: bookId });
  revalidatePath(`/libra/${bookId}`);
  revalidatePath(MY_NOTICES_PATH);
  if (from === "list") redirect(error ? `${MY_NOTICES_PATH}?notify=error` : MY_NOTICES_PATH);
  redirect(`/libra/${bookId}?notify=${error ? "error" : "off"}`);
}
