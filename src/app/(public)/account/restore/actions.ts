"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

// DEL (del2 b): Restore. restore_my_account (migration 20261118170000)
// brings back the books, bundles and pre-orders that went offline, as a
// lifted suspension does, and ends the pending deletion.
export async function restoreAccount() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase.rpc("restore_my_account");
  if (error) {
    console.error("restoreAccount: restore failed", { code: (error as { code?: string }).code ?? null });
    redirect(`/account/restore?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri.")}`);
  }
  if (data === "too_late") {
    redirect(
      `/account/restore?error=${encodeURIComponent(
        "Fshirja e llogarisë ka nisur dhe nuk mund të ndalet më.",
      )}`,
    );
  }
  if (data !== "restored" && data !== "not_pending") {
    redirect(`/account/restore?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri.")}`);
  }

  revalidatePath("/", "layout");
  redirect("/account");
}
