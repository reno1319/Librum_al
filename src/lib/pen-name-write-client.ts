import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { parsePenNameName } from "@/lib/pen-names";

// PEN-NAMES-1 (migration 20261019184512, N2): the ONE way a Server
// Action gets authority to create a pen name, set its photo path or
// delete it. `authenticated` holds only SELECT (own rows) and
// UPDATE(name, bio, links) on public.pen_names; author_id, avatar_path,
// is_default, INSERT and DELETE are server-only.
//
// Rules every caller follows:
//   1. Authenticate with the session client first and pass ONLY the
//      session user's id as the author -- never an id from the form.
//   2. Every UPDATE/DELETE through this client is filtered by BOTH the
//      pen name id and `author_id = <session user id>` (it bypasses RLS,
//      so those filters are the ownership boundary).
//   3. Creating a pen name goes through resolve_author_pen_name (EXECUTE
//      for service_role only), which finds the author's pen name by
//      lower(name) or creates it, and gives the default for an empty
//      name.
//
// `server-only` keeps the key out of browser code.
export function createPenNameWriteClient() {
  return createAdminClient();
}

export type ResolvePenNameResult =
  | { ok: true; penNameId: string }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "failed" };

// The pen name box under Title (10a): an empty box means the author's
// default pen name; a name the author already uses (any case) is that
// pen name; a new name creates one.
export async function resolveOwnPenNameId(
  authorId: string,
  rawName: string | null,
): Promise<ResolvePenNameResult> {
  let name: string | null = null;
  if (rawName !== null && rawName.trim() !== "") {
    const parsed = parsePenNameName(rawName);
    if (!parsed.ok) return { ok: false, reason: "invalid", message: parsed.message };
    name = parsed.name;
  }

  const { data, error } = await createPenNameWriteClient().rpc("resolve_author_pen_name", {
    p_author_id: authorId,
    p_name: name,
  });
  if (error || typeof data !== "string") {
    console.error("resolveOwnPenNameId failed:", error);
    return { ok: false, reason: "failed" };
  }
  return { ok: true, penNameId: data };
}
