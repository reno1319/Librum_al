// PEN-2: live ports for the storage move -- supabase-js with the
// service-role key. Never run in tests or against any project outside a
// run plan with Renato's typed approval (DB flow). The key is read from
// the env file and is never printed; no error message here includes a
// key, row id or account id.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseSupabaseProjectRef, PRODUCTION_SUPABASE_PROJECT_REF } from "../../src/lib/supabase/env-guard.ts";
import { STAGING_SUPABASE_PROJECT_REF } from "../staging-fixtures/guard.mts";
import { StorageNotFoundError, type DbPort, type KeyRow, type StorageEntry, type StoragePort } from "./core.mts";
import type { Target } from "./keys.mts";

export const URL_ENV = "PEN_NAMES_STORAGE_SUPABASE_URL";
export const KEY_ENV = "SUPABASE_SERVICE_ROLE_KEY";

export class UnsafeTargetError extends Error {}

// The script may target only the staging or the production project, and
// only the one the operator names with --project-ref (which the typed
// confirmation repeats). A third project is refused.
export function assertTarget(url: string | undefined, projectRef: string | undefined): string {
  const ref = parseSupabaseProjectRef(url);
  if (ref === null) throw new UnsafeTargetError(`${URL_ENV} is missing or is not https://<project-ref>.supabase.co`);
  if (ref !== STAGING_SUPABASE_PROJECT_REF && ref !== PRODUCTION_SUPABASE_PROJECT_REF) {
    throw new UnsafeTargetError(`${URL_ENV} names a project that is neither staging nor production`);
  }
  if (!projectRef || projectRef !== ref) {
    throw new UnsafeTargetError(`--project-ref must name the project in ${URL_ENV}`);
  }
  return ref;
}

export function buildServiceClient(projectRef: string | undefined): { client: SupabaseClient; ref: string } {
  const url = process.env[URL_ENV];
  const ref = assertTarget(url, projectRef);
  const key = process.env[KEY_ENV];
  if (!key || key.trim() === "") throw new UnsafeTargetError(`${KEY_ENV} is missing or empty`);
  const client = createClient(url as string, key, { auth: { autoRefreshToken: false, persistSession: false } });
  return { client, ref };
}

type StorageErrorLike = { status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };

function isNotFound(error: unknown): boolean {
  const e = (error ?? {}) as StorageErrorLike;
  return e.status === 404 || e.statusCode === "404" || e.code === "NoSuchKey" || e.code === "not_found";
}

function fail(operation: string, error: unknown): never {
  if (isNotFound(error)) throw new StorageNotFoundError(`${operation}: not found`);
  const e = (error ?? {}) as StorageErrorLike;
  throw new Error(`${operation}: storage error (status ${String(e.status ?? "unknown")})`);
}

export function liveStorage(client: SupabaseClient): StoragePort {
  return {
    async copy(bucket, from, to) {
      const { error } = await client.storage.from(bucket).copy(from, to);
      if (error) fail("copy", error);
    },
    async download(bucket, key) {
      const { data, error } = await client.storage.from(bucket).download(key);
      if (error || !data) fail("download", error);
      return new Uint8Array(await data.arrayBuffer());
    },
    async list(bucket, prefix) {
      const out: StorageEntry[] = [];
      const limit = 1000;
      for (let offset = 0; ; offset += limit) {
        const { data, error } = await client.storage
          .from(bucket)
          .list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } });
        if (error || !data) fail("list", error);
        // A folder comes back with a null id.
        for (const item of data) out.push({ name: item.name, folder: item.id === null });
        if (data.length < limit) break;
      }
      return out;
    },
    async remove(bucket, keys) {
      const { error } = await client.storage.from(bucket).remove(keys);
      if (error) fail("remove", error);
    },
  };
}

const COLUMN: Record<Target, { table: string; column: string }> = {
  cover: { table: "books", column: "cover_path" },
  pen_name_photo: { table: "pen_names", column: "avatar_path" },
};

export function liveDb(client: SupabaseClient): DbPort {
  async function pageAll<T>(read: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
    const out: T[] = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await read(from, from + size - 1);
      if (error || !data) throw new Error("database read failed");
      out.push(...data);
      if (data.length < size) break;
    }
    return out;
  }

  return {
    async listRows(target) {
      const { table, column } = COLUMN[target];
      // A plain string, so supabase-js does not try to parse it as a type.
      const columns: string = `id, author_id, ${column}`;
      const rows = await pageAll<Record<string, unknown>>((from, to) =>
        client.from(table).select(columns).not(column, "is", null).order("id").range(from, to).returns<Record<string, unknown>[]>(),
      );
      return rows.map((r): KeyRow => ({ id: String(r.id), accountId: String(r.author_id), key: String(r[column]) }));
    },
    async cas(target, id, prev, next) {
      const { table, column } = COLUMN[target];
      const { data, error } = await client
        .from(table)
        .update({ [column]: next })
        .eq("id", id)
        .eq(column, prev)
        .select("id");
      if (error) throw new Error("database write failed");
      return Array.isArray(data) && data.length === 1;
    },
    async listProfilePhotos() {
      const rows = await pageAll<{ id: string; avatar_path: string }>((from, to) =>
        client.from("profiles").select("id, avatar_path").not("avatar_path", "is", null).order("id").range(from, to),
      );
      return rows.map((r) => ({ id: r.id, key: r.avatar_path }));
    },
    async casProfilePhotoToNull(id, prev) {
      const { data, error } = await client
        .from("profiles")
        .update({ avatar_path: null })
        .eq("id", id)
        .eq("avatar_path", prev)
        .select("id");
      if (error) throw new Error("database write failed");
      return Array.isArray(data) && data.length === 1;
    },
  };
}
