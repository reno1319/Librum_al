// BD5 (Renato 1 Nov, 2b + 3a): an uploaded manuscript or cover waits
// in the author's temporary folder for 3 days. After that the form
// stops a Save and asks for the file again -- before anything is sent,
// so nothing the author typed is lost -- instead of letting the server
// fail to read a file the nightly clean-up may have removed.
//
// The clock here is the browser's own, measured from the moment the
// upload finished; the clean-up (tmp-upload-cleanup.ts) measures from
// the stored object's newest timestamp and waits until 84 hours, so a
// file the form still accepts is at least half a day away from removal.
// If the device clock has gone backwards by more than an hour, the
// elapsed time can't be trusted and the upload counts as expired.
import { TMP_UPLOAD_MIN_AGE_MS } from "@/lib/tmp-upload-cleanup";

const HOUR_MS = 60 * 60 * 1000;
export const TEMP_UPLOAD_FORM_LIMIT_MS = 72 * HOUR_MS;
const CLOCK_BACKWARDS_TOLERANCE_MS = HOUR_MS;

// The form must always give up well before the clean-up can act.
if (TMP_UPLOAD_MIN_AGE_MS - TEMP_UPLOAD_FORM_LIMIT_MS < 12 * HOUR_MS) {
  throw new Error("temp-upload-expiry: the clean-up must wait at least 12 hours longer than the form");
}

export const TEMP_UPLOAD_EXPIRED_MESSAGE =
  "Skedari që ngarkuat ka më shumë se 3 ditë dhe është hequr. Zgjidheni përsëri. Gjithçka tjetër që keni shkruar mbetet.";

// How often an open form re-checks its upload's age.
export const TEMP_UPLOAD_CHECK_INTERVAL_MS = 60 * 1000;

export function tempUploadExpired(uploadedAtMs: number | null, nowMs: number): boolean {
  if (uploadedAtMs === null) return false;
  const elapsed = nowMs - uploadedAtMs;
  return elapsed >= TEMP_UPLOAD_FORM_LIMIT_MS || elapsed < -CLOCK_BACKWARDS_TOLERANCE_MS;
}
