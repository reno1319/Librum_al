import "server-only";
import type { createClient } from "@/lib/supabase/server";

// PEN-NAMES-2 (MF3, C13): support staff (refunds.view) no longer read
// profiles directly -- that let them read any author's default pen name
// (profiles.public_author_name) and so tie it to an account. Display
// names for the refund pages come from staff_profile_display_names()
// instead: refunds.view only, display names only, and only for ids that
// appear on a refund request (reader or reviewer) or belong to staff.
//
// Fails soft like the profiles read it replaces: an error or an empty id
// list gives an empty map, and the callers' resolveProfileDisplayName()
// then shows their "unknown" wording.
export async function loadStaffDisplayNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(ids.filter((id) => typeof id === "string" && id.length > 0)));
  if (unique.length === 0) return new Map();
  const { data, error } = await supabase.rpc("staff_profile_display_names", { p_ids: unique });
  if (error) {
    console.error("loadStaffDisplayNames: staff_profile_display_names failed", { code: error.code ?? null });
    return new Map();
  }
  const rows = (data ?? []) as { id: string; display_name: string }[];
  return new Map(rows.map((row) => [row.id, row.display_name]));
}
