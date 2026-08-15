"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export async function deleteAccount(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const confirmation = String(formData.get("confirmation") ?? "");
  if (confirmation !== "DELETE") {
    redirect("/account?error=Type+DELETE+to+confirm");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("avatar_path")
    .eq("id", user.id)
    .single();

  const { data: books } = await supabase
    .from("books")
    .select("cover_path, file_path")
    .eq("author_id", user.id)
    .returns<{ cover_path: string | null; file_path: string | null }[]>();

  const admin = createAdminClient();

  const coverPaths = (books ?? [])
    .map((b) => b.cover_path)
    .filter((p): p is string => !!p);
  const manuscriptPaths = (books ?? [])
    .map((b) => b.file_path)
    .filter((p): p is string => !!p);

  if (coverPaths.length > 0) {
    await admin.storage.from("covers").remove(coverPaths);
  }
  if (manuscriptPaths.length > 0) {
    await admin.storage.from("manuscripts").remove(manuscriptPaths);
  }
  if (profile?.avatar_path) {
    await admin.storage.from("avatars").remove([profile.avatar_path]);
  }

  // Cascades through profiles -> books -> purchases/reviews via the
  // schema's ON DELETE CASCADE foreign keys.
  await admin.auth.admin.deleteUser(user.id);
  await supabase.auth.signOut();

  revalidatePath("/", "layout");
  redirect("/?account=deleted");
}
