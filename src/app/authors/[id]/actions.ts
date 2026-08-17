"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

export async function followAuthor(authorId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/authors/${authorId}`);
  }

  if (user.id === authorId) {
    redirect(`/authors/${authorId}`);
  }

  await supabase.from("author_follows").insert({
    follower_id: user.id,
    author_id: authorId,
  });

  revalidatePath(`/authors/${authorId}`);
  revalidatePath("/following");
}

export async function unfollowAuthor(authorId: string) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("author_follows")
    .delete()
    .eq("follower_id", user.id)
    .eq("author_id", authorId);

  revalidatePath(`/authors/${authorId}`);
  revalidatePath("/following");
}
