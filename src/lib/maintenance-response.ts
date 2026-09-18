import "server-only";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";

// ALL-CUTOVER APP-A: one shared, deterministic user-facing message for
// every maintenance rejection, Server Actions and Route Handlers alike.
// Never includes an environment value, secret, internal identifier, or
// anything derived from request input.
export const MAINTENANCE_MESSAGE =
  "Librum is temporarily unavailable for scheduled maintenance. Please try again shortly.";

// For a Server Action whose EXISTING convention on every other error
// path is `redirect(\`${path}?error=...\`)` -- true of every mutating
// action this gate covers that already has a business-error redirect
// target of its own. Reuses that exact convention for the maintenance
// rejection, so no caller-visible signature or behavior shape changes.
export function redirectForMaintenance(path: string): never {
  redirect(`${path}?error=${encodeURIComponent(MAINTENANCE_MESSAGE)}`);
}

// For a Server Action with NO existing redirect-based error convention
// of its own (it mutates and revalidates, with no business-error
// redirect target to mirror) -- a plain, stable thrown Error instead of
// inventing a new redirect target that would be inconsistent with the
// function's own established shape.
export function throwMaintenanceError(): never {
  throw new Error(MAINTENANCE_MESSAGE);
}

// For a Route Handler -- a stable, temporary-unavailable HTTP response.
// Never leaks a secret, header, or the raw env value.
export function maintenanceHttpResponse(): NextResponse {
  return NextResponse.json({ error: MAINTENANCE_MESSAGE }, { status: 503 });
}
