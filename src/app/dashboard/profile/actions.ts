"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export async function updateProfile(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const displayName = String(formData.get("displayName") ?? "").trim();
  const bio = String(formData.get("bio") ?? "").trim();
  const avatar = formData.get("avatar") as File | null;

  if (!displayName) {
    redirect("/dashboard/profile?error=Name+can%27t+be+empty");
  }

  if (avatar && avatar.size > 0) {
    if (avatar.size > MAX_AVATAR_BYTES) {
      redirect("/dashboard/profile?error=Avatar+must+be+under+5MB");
    }

    const ext = avatar.name.split(".").pop() || "jpg";
    const avatarPath = `${user.id}/avatar.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from("avatars")
      .upload(avatarPath, avatar, { contentType: avatar.type, upsert: true });

    if (uploadError) {
      redirect(`/dashboard/profile?error=${encodeURIComponent(uploadError.message)}`);
    }

    await supabase
      .from("profiles")
      .update({ display_name: displayName, bio, avatar_path: avatarPath })
      .eq("id", user.id);
  } else {
    await supabase
      .from("profiles")
      .update({ display_name: displayName, bio })
      .eq("id", user.id);
  }

  revalidatePath("/", "layout");
  redirect("/dashboard/profile?success=1");
}
