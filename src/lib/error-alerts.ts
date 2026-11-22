import { escapeEmailHtml, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { createAdminClient } from "@/lib/supabase/admin";

// ALERTS-1 (Renato 10-27, 4b): email the team when the live site hits a
// server error -- a page, Route Handler, Server Action or Proxy that
// threw -- through Resend, which already sends the site's email. Called
// from onRequestError in src/instrumentation.ts. Server errors only: an
// error that happens only in the browser is not seen here.
//
// To support@librum.al (forwarded to the owner), not to staff read from
// the database: a database outage is exactly when this must still
// send. Production only (VERCEL_ENV), so previews and local runs never
// email anyone.
//
// Cap (r2, Renato 10-27: few emails, Resend stays on its free plan of
// 100 a day shared with every other site email): at most one email per
// hour and at most ERROR_EMAILS_PER_DAY per UTC day. Errors in between
// are counted and the count rides on the next email.
//
// N18 (Renato 11-21): the cap is ONE count for the whole site, kept in
// the database by claim_error_email_slot() (migration
// 20261121170000_error_email_shared_cap.sql), so many Vercel instances
// no longer get 3 a day each. Site errors and nightly-job failures share
// it (e2 a). Each instance still keeps its own count in memory and asks
// the database only when its own count allows a send. When the database
// cannot be asked (down, slow, or the function missing), the instance's
// own count decides, as before N18 (e1 a): an outage is exactly when the
// email matters, and the worst case then is ERROR_EMAILS_PER_DAY times
// the number of instances that hit errors.
//
// What the email holds (no visitor identity): time, method, the path
// WITHOUT its query string (a query can carry a key or code), the route
// file, the kind of route, and the error's name, digest and message.
// Both the path and the message have email addresses, long token-like
// strings (ids included) and long hex runs blanked, and are cut short. Best effort like every email: never throws.
export const ERROR_EMAIL_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const ERROR_EMAILS_PER_DAY = 3;
// How long the shared count may take to answer before the instance's
// own count decides (e1 a).
export const SHARED_CAP_TIMEOUT_MS = 3000;
// r2 (audit M1): after the shared count says no, this instance does not
// ask again for this long, so an error storm on a healthy database is at
// most one question per instance every few minutes, not one per error.
export const SHARED_REFUSAL_BACKOFF_MS = 5 * 60 * 1000;
const MAX_MESSAGE_LENGTH = 300;
const MAX_PATH_LENGTH = 200;

// Next.js signals redirects, notFound() and similar with thrown values
// that are not failures; never email those.
const CONTROL_FLOW_DIGESTS = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

type RequestInfo = { path: string; method: string };
type ContextInfo = { routePath: string; routeType: string };

const throttle = {
  lastSentAt: null as number | null,
  refusedAt: null as number | null,
  day: "",
  sentToday: 0,
  skipped: 0,
};

// Tests only.
export function resetErrorAlertThrottle() {
  throttle.lastSentAt = null;
  throttle.refusedAt = null;
  throttle.day = "";
  throttle.sentToday = 0;
  throttle.skipped = 0;
}

// N18: true = the shared count allows a send (and counted it), false =
// it does not, null = it could not be asked.
async function claimSharedSlot(): Promise<boolean | null> {
  try {
    const { data, error } = await createAdminClient()
      .rpc("claim_error_email_slot", {
        p_per_day: ERROR_EMAILS_PER_DAY,
        p_min_interval_seconds: ERROR_EMAIL_MIN_INTERVAL_MS / 1000,
      })
      .abortSignal(AbortSignal.timeout(SHARED_CAP_TIMEOUT_MS));
    if (error || typeof data !== "boolean") return null;
    return data;
  } catch {
    return null;
  }
}

function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function redact(value: string): string {
  return value
    .replace(/[^\s@<>"'/]+@[^\s@<>"'/]+/g, "[email]")
    .replace(/[A-Za-z0-9_\-+=]{32,}/g, "[token]")
    .replace(/[0-9a-fA-F]{16,}/g, "[hex]");
}

export function redactErrorMessage(message: string): string {
  return cut(redact(message), MAX_MESSAGE_LENGTH);
}

// r2 (audit L1): the path is cleaned too, after decoding, so %40 counts
// as @. A path that will not decode is cleaned as it is.
export function cleanPath(path: string): string {
  const bare = path.split(/[?#]/, 1)[0] ?? "";
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // Malformed percent-encoding: keep the raw path.
  }
  return cut(redact(decoded), MAX_PATH_LENGTH);
}

function errorParts(error: unknown): { name: string; message: string; digest: string | null } {
  const digest =
    typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : null;
  if (error instanceof Error) return { name: error.name, message: error.message, digest };
  return { name: typeof error, message: String(error), digest };
}

// Subjects are plain text and built only from the route FILE path,
// which comes from the code, never from the visitor's URL.
function subjectText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
}

export async function reportServerError(error: unknown, request: RequestInfo, context: ContextInfo, now = Date.now()) {
  try {
    if (process.env.VERCEL_ENV !== "production") return;
    const { name, message, digest } = errorParts(error);
    if (digest && CONTROL_FLOW_DIGESTS.test(digest)) return;

    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== throttle.day) {
      throttle.day = day;
      throttle.sentToday = 0;
    }
    if (
      throttle.sentToday >= ERROR_EMAILS_PER_DAY ||
      (throttle.lastSentAt !== null && now - throttle.lastSentAt < ERROR_EMAIL_MIN_INTERVAL_MS) ||
      (throttle.refusedAt !== null && now - throttle.refusedAt < SHARED_REFUSAL_BACKOFF_MS)
    ) {
      throttle.skipped += 1;
      return;
    }
    // Reserve the send in memory BEFORE asking the shared count, so a
    // second error on this instance in the meantime is skipped as before.
    const previousSentAt = throttle.lastSentAt;
    throttle.lastSentAt = now;
    throttle.sentToday += 1;
    const shared = await claimSharedSlot();
    if (shared === false) {
      // Another instance used the shared allowance: give the reservation
      // back, and do not ask again for SHARED_REFUSAL_BACKOFF_MS.
      throttle.lastSentAt = previousSentAt;
      throttle.sentToday = Math.max(0, throttle.sentToday - 1);
      throttle.refusedAt = now;
      throttle.skipped += 1;
      return;
    }
    const skipped = throttle.skipped;
    throttle.skipped = 0;

    const rows: [string, string][] = [
      ["Time (UTC)", new Date(now).toISOString()],
      ["Request", `${request.method} ${cleanPath(request.path)}`],
      ["Route file", context.routePath],
      ["Kind", context.routeType],
      ["Error", name],
      ["Digest", digest ?? "none"],
      ["Message", redactErrorMessage(message)],
    ];
    const more =
      skipped > 0
        ? `<p>${skipped} more server error${skipped === 1 ? "" : "s"} on this server since the last email were not emailed (at most one email an hour and ${ERROR_EMAILS_PER_DAY} a day ${shared ? "for the whole site" : "on this server, as the shared count could not be reached"}).</p>`
        : "";

    await sendEmail(
      SUPPORT_EMAIL,
      `Site error: ${subjectText(`${context.routeType} ${context.routePath}`)}`,
      `<div style="font-family: sans-serif; max-width: 560px; margin: 0 auto;">
        <h1 style="font-size: 20px;">The live site hit a server error</h1>
        <table style="border-collapse: collapse;">${rows
          .map(
            ([label, value]) =>
              `<tr><td style="padding: 2px 12px 2px 0; vertical-align: top;"><strong>${label}</strong></td><td>${escapeEmailHtml(value)}</td></tr>`,
          )
          .join("")}</table>
        ${more}
        <p>Vercel keeps logs for about an hour: search the runtime logs for the digest or the time above soon.</p>
      </div>`,
    );
  } catch (caught) {
    console.error("reportServerError failed", { error: caught instanceof Error ? caught.name : "unknown" });
  }
}

// ALERTS-2: what the owner's test link (/admin/test-error-email) throws.
export const TEST_ERROR_MESSAGE = "Test error from the owner's test link (ALERTS-2). Nothing is broken.";

// ALERTS-2 (Renato 11-20, a): the nightly jobs (vercel.json crons) catch
// their own failures and answer 500 or 503 instead of throwing, so
// onRequestError never sees them. Each job's GET passes its response
// here: a 5xx is emailed through reportServerError above, with the same
// Production-only gate and the same cap (N18: one shared count, e2 a).
// Only the job's route path and the status code go in the email, never the response body. Skipped
// while maintenance mode is on, since every job then answers 503 on
// purpose. A thrown error is not handled here: it already reaches
// onRequestError. Returns the response unchanged.
export async function alertIfCronFailed(routePath: string, response: Response, now = Date.now()): Promise<Response> {
  if (response.status >= 500 && !resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    const failure = new Error(`Nightly job answered HTTP ${response.status}`);
    failure.name = "CronJobFailed";
    await reportServerError(failure, { path: routePath, method: "GET" }, { routePath, routeType: "cron" }, now);
  }
  return response;
}
