"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { isUuid } from "../book-admin-logic";

// LR1 patch 2 (lr2-1 a): staff take a book's "only on Librum" tick off;
// the author cannot tick it again. requireStaff("catalog.feature")
// (owner and admin) keeps everyone else away; the database function
// checks the permission again, changes the book and writes the audit
// row (book.only_on_librum_removed) in one transaction.
const ONLY_ON_LIBRUM_REMOVED_MESSAGE = "Removed from the “only on Librum” shelf.";
const ONLY_ON_LIBRUM_NOT_TICKED_MESSAGE = "This book isn’t ticked “only on Librum” any more.";
const ONLY_ON_LIBRUM_FAILED_MESSAGE = "Couldn’t remove it from the shelf. Please try again.";

export async function removeOnlyOnLibrum(bookId: string) {
  await requireStaff("catalog.feature");
  if (!isUuid(bookId)) redirect("/admin/books");
  const path = `/admin/books/${bookId}`;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_remove_only_on_librum", { p_book_id: bookId });
  if (error) {
    console.error("removeOnlyOnLibrum: staff_remove_only_on_librum failed:", error);
    redirect(`${path}?error=${encodeURIComponent(ONLY_ON_LIBRUM_FAILED_MESSAGE)}`);
  }
  if (data !== true) redirect(`${path}?error=${encodeURIComponent(ONLY_ON_LIBRUM_NOT_TICKED_MESSAGE)}`);

  revalidatePath(path);
  revalidatePath("/librari");
  redirect(`${path}?success=${encodeURIComponent(ONLY_ON_LIBRUM_REMOVED_MESSAGE)}`);
}
