import { escapeEmailHtml, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/contact";

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
// 100 a day shared with every other site email): per server instance,
// at most one email per hour and at most ERROR_EMAILS_PER_DAY per UTC
// day. Errors in between are counted and the count rides on the next
// email. The cap lives in memory, so each Vercel instance has its own:
// the worst case is ERROR_EMAILS_PER_DAY times the number of instances
// that hit errors that day (a new instance after a cold start counts as
// another one). With 3 a day, ten such instances stay at 30.
//
// What the email holds (no visitor identity): time, method, the path
// WITHOUT its query string (a query can carry a key or code), the route
// file, the kind of route, and the error's name, digest and message.
// Both the path and the message have email addresses, long token-like
// strings (ids included) and long hex runs blanked, and are cut short. Best effort like every email: never throws.
export const ERROR_EMAIL_MIN_INTERVAL_MS = 60 * 60 * 1000;
export const ERROR_EMAILS_PER_DAY = 3;
const MAX_MESSAGE_LENGTH = 300;
const MAX_PATH_LENGTH = 200;

// Next.js signals redirects, notFound() and similar with thrown values
// that are not failures; never email those.
const CONTROL_FLOW_DIGESTS = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|NEXT_HTTP_ERROR_FALLBACK|DYNAMIC_SERVER_USAGE|BAILOUT_TO_CLIENT_SIDE_RENDERING)/;

type RequestInfo = { path: string; method: string };
type ContextInfo = { routePath: string; routeType: string };

const throttle = { lastSentAt: null as number | null, day: "", sentToday: 0, skipped: 0 };

// Tests only.
export function resetErrorAlertThrottle() {
  throttle.lastSentAt = null;
  throttle.day = "";
  throttle.sentToday = 0;
  throttle.skipped = 0;
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
      (throttle.lastSentAt !== null && now - throttle.lastSentAt < ERROR_EMAIL_MIN_INTERVAL_MS)
    ) {
      throttle.skipped += 1;
      return;
    }
    const skipped = throttle.skipped;
    throttle.lastSentAt = now;
    throttle.sentToday += 1;
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
        ? `<p>${skipped} more server error${skipped === 1 ? "" : "s"} on this server since the last email were not emailed (at most one email an hour and ${ERROR_EMAILS_PER_DAY} a day).</p>`
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
