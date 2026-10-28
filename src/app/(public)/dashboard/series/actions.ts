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
  // PEN-NAMES-1 (11a): a series belongs to one pen name, chosen here.
  // Empty means the author's default pen name (the database fills it).
  const penNameId = String(formData.get("penNameId") ?? "").trim();

  if (!title) {
    redirect(`/dashboard/series?error=${encodeURIComponent("Shkruani titullin e serisë")}`);
  }

  if (penNameId) {
    // Must be one of the caller's own pen names (RLS + author filter);
    // the series trigger checks the same again.
    const { data: ownPenName } = await supabase
      .from("pen_names")
      .select("id")
      .eq("id", penNameId)
      .eq("author_id", user.id)
      .maybeSingle();
    if (!ownPenName) {
      redirect(`/dashboard/series?error=${encodeURIComponent("Zgjidhni një nga pseudonimet tuaja.")}`);
    }
  }

  const { error } = await supabase.from("series").insert({
    author_id: user.id,
    title,
    ...(penNameId ? { pen_name_id: penNameId } : {}),
  });

  if (error) {
    // LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: was error.message -- see the
    // identical correction in src/app/books/[id]/actions.ts for why.
    redirect(
      `/dashboard/series?error=${encodeURIComponent("Seria nuk u krijua dot. Provoni përsëri.")}`,
    );
  }

  revalidatePath("/dashboard/series");
  redirect(`/dashboard/series?success=${encodeURIComponent("Seria u krijua")}`);
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
