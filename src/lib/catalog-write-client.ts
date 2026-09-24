import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// CATALOG-WRITE-AUTH-1: the ONE way a Server Action obtains authority to
// write the protected catalog columns of public.books and public.bundles
// (`status`, `price_all`, `published_at`).
//
// Since migration 20260924101853_catalog_write_authorization,
// `authenticated` can no longer write those columns directly: a session
// client, and therefore the Data API an author's browser can reach,
// holds INSERT only on the columns of a new draft and UPDATE only on
// books.series_id / books.series_position. The protected transitions
// (publish, unpublish, and an edit that carries a price) are decided in
// the Server Actions -- paid-publishing permission, repricing rule,
// ownership, maintenance and recovery -- and only then written through
// this client, which uses the server-only service-role key.
//
// Rules every caller follows, each pinned by
// src/app/(public)/dashboard/catalog-write-authorization.test.ts:
//
//   1. Authenticate with the session client first, and run every
//      rejecting gate and ownership read BEFORE calling this. A request
//      that is going to be refused never creates privileged authority.
//   2. Every write is filtered by BOTH the row id and
//      `author_id = <the authenticated user's id>`. This client bypasses
//      RLS, so those filters are the ownership boundary.
//   3. Every write returns `.select("id")` and must prove exactly one row
//      changed (isExactlyOneRowWritten). Zero or several rows fail closed.
//   4. Ordinary reads, uploads, deletes and the series unlink stay on the
//      least-privileged session client.
//
// `server-only` makes any import of this module from a client component
// a build error, so the key can never reach browser code through it.
export function createCatalogWriteClient() {
  return createAdminClient();
}
