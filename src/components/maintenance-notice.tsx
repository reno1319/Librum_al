import { MAINTENANCE_MESSAGE } from "@/lib/maintenance-response";

// ALL-CUTOVER APP-A: the single shared static notice every schema-
// sensitive page (V3 §3) renders in place of its normal content while
// ALL_CUTOVER_MAINTENANCE_MODE is active. A Server Component by default
// (no "use client" directive, no client-only API used) -- it never
// needs to exist in any client bundle. Deterministic markup only: no
// price, identifier, environment value, or secret is ever read or
// interpolated here.
export function MaintenanceNotice() {
  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-16 text-center sm:px-6">
      <h1 className="font-serif text-2xl font-semibold sm:text-3xl">Scheduled maintenance</h1>
      <p className="mt-3 text-muted">{MAINTENANCE_MESSAGE}</p>
    </main>
  );
}
