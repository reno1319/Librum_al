import { describe, expect, it } from "vitest";
import {
  TEMP_UPLOAD_EXPIRED_MESSAGE,
  TEMP_UPLOAD_FORM_LIMIT_MS,
  tempUploadExpired,
} from "./temp-upload-expiry";
import { TMP_UPLOAD_MIN_AGE_MS } from "./tmp-upload-cleanup";

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T10:00:00Z");

describe("tempUploadExpired (BD5, 3 days)", () => {
  it("is 3 days for the form, with the clean-up at least 12 hours later", () => {
    expect(TEMP_UPLOAD_FORM_LIMIT_MS).toBe(72 * HOUR);
    expect(TMP_UPLOAD_MIN_AGE_MS - TEMP_UPLOAD_FORM_LIMIT_MS).toBeGreaterThanOrEqual(12 * HOUR);
  });

  it("nothing uploaded never expires", () => {
    expect(tempUploadExpired(null, T0 + 1000 * HOUR)).toBe(false);
  });

  it("expires at 3 days, not before", () => {
    expect(tempUploadExpired(T0, T0)).toBe(false);
    expect(tempUploadExpired(T0, T0 + 72 * HOUR - 1)).toBe(false);
    expect(tempUploadExpired(T0, T0 + 72 * HOUR)).toBe(true);
  });

  it("a clock that went back more than an hour counts as expired; a small wobble does not", () => {
    expect(tempUploadExpired(T0, T0 - 30 * 60 * 1000)).toBe(false);
    expect(tempUploadExpired(T0, T0 - 2 * HOUR)).toBe(true);
  });

  it("the message says the file is gone and the rest of the form is kept", () => {
    expect(TEMP_UPLOAD_EXPIRED_MESSAGE).toBe(
      "Skedari që ngarkuat ka më shumë se 3 ditë dhe është hequr. Zgjidheni përsëri. Gjithçka tjetër që keni shkruar mbetet.",
    );
  });
});
