"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import { mapClassicAuthorRpcError, validateClassicAuthorForm } from "@/lib/classic-authors";

// K6 free Albanian classics (Q1 a): staff add and edit classic authors
// and link each public-domain work to one. Same shape as the other
// staff actions: the maintenance gate, requireStaff("books.review") as
// defense in depth, then the RPC through the staff member's own session
// client (auth.uid() is that staff member). The RPC is the authority:
// it re-checks books.review and every field. Errors are mapped, never
// shown raw. redirect() stays outside every try/catch.

const WORKS_PATH = "/admin/books/public-domain";
const AUTHORS_PATH = "/admin/books/public-domain/authors";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

function revalidateClassics(paths: string[], caller: string): void {
  // The public pages that show a classic's years or page.
  for (const path of new Set(["/", "/librari", ...paths])) {
    try {
      revalidatePath(path);
    } catch (revalidateError) {
      console.error(`${caller}: revalidatePath failed`, { path, error: revalidateError });
    }
  }
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export async function saveClassicAuthorAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(AUTHORS_PATH);
  }

  await requireStaff("books.review");

  const rawId = formData.get("id");
  const formPath = isUuid(rawId) ? `${AUTHORS_PATH}/${rawId}` : AUTHORS_PATH;

  const validation = validateClassicAuthorForm(formData, new Date().getUTCFullYear());
  if (!validation.ok) {
    redirect(withQuery(formPath, "error", validation.error));
  }
  const input = validation.value;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_save_classic_author", {
    p_id: input.id,
    p_slug: input.slug,
    p_name: input.name,
    p_birth_year: input.birthYear,
    p_death_year: input.deathYear,
    p_birth_place: input.birthPlace,
    p_death_place: input.deathPlace,
    p_bio: input.bio,
  });

  if (error) {
    if (error.message === "not authenticated") {
      redirect(`/login?next=${encodeURIComponent(formPath)}`);
    }
    console.error("saveClassicAuthorAsStaff: staff_save_classic_author failed", { code: error.code });
    redirect(withQuery(formPath, "error", mapClassicAuthorRpcError(error)));
  }

  revalidateClassics([AUTHORS_PATH, WORKS_PATH, `/klasiket/${input.slug}`], "saveClassicAuthorAsStaff");

  const savedPath = isUuid(data) ? `${AUTHORS_PATH}/${data}` : AUTHORS_PATH;
  redirect(withQuery(savedPath, "success", "Classic author saved."));
}

export async function setPdWorkClassicAuthorAsStaff(formData: FormData) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance(WORKS_PATH);
  }

  await requireStaff("books.review");

  const workId = formData.get("workId");
  const rawAuthor = formData.get("classicAuthorId");
  const authorId = rawAuthor === "" ? null : rawAuthor;
  if (!isUuid(workId) || (authorId !== null && !isUuid(authorId))) {
    redirect(withQuery(WORKS_PATH, "error", "This author or work no longer exists."));
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("staff_set_pd_work_classic_author", {
    p_work_id: workId,
    p_author_id: authorId,
  });

  if (error) {
    if (error.message === "not authenticated") {
      redirect(`/login?next=${encodeURIComponent(WORKS_PATH)}`);
    }
    console.error("setPdWorkClassicAuthorAsStaff: staff_set_pd_work_classic_author failed", { code: error.code });
    redirect(withQuery(WORKS_PATH, "error", mapClassicAuthorRpcError(error)));
  }

  // The work's live edition now shows (or stops showing) the years and
  // the link; its book page is dynamic, the listings are revalidated.
  revalidateClassics([WORKS_PATH], "setPdWorkClassicAuthorAsStaff");

  redirect(withQuery(WORKS_PATH, "success", "Classic author link saved."));
}
