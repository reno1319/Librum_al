"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function createSeries(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const title = String(formData.get("title") ?? "").trim();

  if (!title) {
    redirect("/dashboard/series?error=Please+enter+a+series+title");
  }

  const { error } = await supabase.from("series").insert({
    author_id: user.id,
    title,
  });

  if (error) {
    // LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: was error.message -- see the
    // identical correction in src/app/books/[id]/actions.ts for why.
    redirect(
      `/dashboard/series?error=${encodeURIComponent("We couldn't create the series. Please try again.")}`,
    );
  }

  revalidatePath("/dashboard/series");
  redirect("/dashboard/series?success=Series+created");
}

export async function deleteSeries(seriesId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Unlink any books first — the foreign key's "on delete set null" would
  // clear series_id automatically, but series_position would be left
  // dangling on a book with no series.
  await supabase
    .from("books")
    .update({ series_id: null, series_position: null })
    .eq("series_id", seriesId)
    .eq("author_id", user.id);

  await supabase.from("series").delete().eq("id", seriesId).eq("author_id", user.id);

  revalidatePath("/dashboard/series");
  revalidatePath("/dashboard");
}
