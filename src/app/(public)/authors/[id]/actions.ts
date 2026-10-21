"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/staff";
import { authorPagePath } from "@/lib/pen-names";

// PEN-NAMES-1 (migration 20261019184512, 4a): a reader follows a PEN
// NAME, not an account. Every id here is a pen name id
// (public.pen_names.id); pen_name_follows' own RLS allows only the
// caller's own rows, and the database refuses following one of your own
// pen names (LB457) -- the check below only avoids that round trip.

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function followPenName(penNameId: string) {
  if (!isUuid(penNameId)) redirect("/");
  const path = authorPagePath(penNameId);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=${path}`);
  }

  // pen_names RLS shows a signed-in author only their own rows, so a hit
  // here means "this is one of my pen names".
  const { data: ownPenName } = await supabase
    .from("pen_names")
    .select("id")
    .eq("id", penNameId)
    .eq("author_id", user.id)
    .maybeSingle();
  if (ownPenName) {
    redirect(path);
  }

  await supabase.from("pen_name_follows").insert({
    follower_id: user.id,
    pen_name_id: penNameId,
  });

  revalidatePath(path);
  revalidatePath("/following");
}

export async function unfollowPenName(penNameId: string) {
  if (!isUuid(penNameId)) redirect("/");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  await supabase
    .from("pen_name_follows")
    .delete()
    .eq("follower_id", user.id)
    .eq("pen_name_id", penNameId);

  revalidatePath(authorPagePath(penNameId));
  revalidatePath("/following");
}

// 8a: staff with reports.resolve remove every link of one pen name. The
// database function re-checks the permission, clears the links and
// writes the audit row (pen_name.links_removed) in one transaction; this
// check only keeps everyone else from reaching it.
export async function removePenNameLinks(penNameId: string) {
  if (!isUuid(penNameId)) redirect("/");
  const path = authorPagePath(penNameId);
  if (!(await hasPermission("reports.resolve"))) {
    redirect(path);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("staff_remove_pen_name_links", {
    p_pen_name_id: penNameId,
  });

  if (error) {
    console.error("removePenNameLinks failed:", error);
    redirect(`${path}?error=${encodeURIComponent("The links could not be removed. Please try again.")}`);
  }

  revalidatePath(path);
  redirect(`${path}?success=${encodeURIComponent("Links removed.")}`);
}
