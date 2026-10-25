import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import type { HomeSlotRow } from "@/lib/home-picks-logic";

// HOME-PICKS-1: reads of the three home page cover slots (migration
// 20261025100000). Before the migration, or on any error, both return
// [] and the home fan shows the newest books.
const FEATURE = "Home picks";

// Only well-formed rows (the page never trusts a shape it did not check).
function slotRows(data: unknown): HomeSlotRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter(
    (r): r is HomeSlotRow =>
      typeof r?.slot === "number" && typeof r?.book_id === "string" && typeof r?.sponsored === "boolean",
  );
}

// The home page: public_home_featured_slots lists only slots whose book
// is published right now.
export async function getPublicHomeSlots(): Promise<HomeSlotRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_home_featured_slots")
    .select("slot, book_id, sponsored")
    .order("slot", { ascending: true });
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(FEATURE, error);
    } else {
      console.error("getPublicHomeSlots: read failed:", error);
    }
    return [];
  }
  return slotRows(data);
}

// The admin page: every filled slot, including one whose book is not
// live now (so staff see why the home page shows another book there).
// The table is service_role-only, so this checks catalog.feature itself
// before creating the service-role client. Book details come from
// public_books on the page (PEN-NAMES-2: no base books read here).
export async function getHomeSlotsForStaff(): Promise<{ ok: true; slots: HomeSlotRow[] } | { ok: false }> {
  await requireStaff("catalog.feature");
  const { data, error } = await createAdminClient()
    .from("home_featured_slots")
    .select("slot, book_id, sponsored")
    .order("slot", { ascending: true });
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(FEATURE, error);
      return { ok: true, slots: [] };
    }
    console.error("getHomeSlotsForStaff: read failed:", error);
    return { ok: false };
  }
  return { ok: true, slots: slotRows(data) };
}
