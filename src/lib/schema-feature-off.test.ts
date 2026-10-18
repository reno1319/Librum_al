import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isSchemaFeatureOffError,
  logSchemaFeatureOffOnce,
  resetSchemaFeatureOffLogForTests,
} from "./schema-feature-off";

describe("isSchemaFeatureOffError", () => {
  it.each(["42703", "42P01", "42883", "PGRST204", "PGRST205", "PGRST202"])("%s means feature off", (code) => {
    expect(isSchemaFeatureOffError({ code })).toBe(true);
  });

  it.each(["42501", "23505", "23502", "23514", "PGRST116", "P0001", "08006", "", "42P0", "pgrst205"])(
    "%s is a real error, not feature off",
    (code) => {
      expect(isSchemaFeatureOffError({ code })).toBe(false);
    },
  );

  it("no error, or an error without a code, is not feature off", () => {
    expect(isSchemaFeatureOffError(null)).toBe(false);
    expect(isSchemaFeatureOffError(undefined)).toBe(false);
    expect(isSchemaFeatureOffError({})).toBe(false);
    expect(isSchemaFeatureOffError({ code: null })).toBe(false);
  });
});

describe("logSchemaFeatureOffOnce", () => {
  afterEach(() => {
    resetSchemaFeatureOffLogForTests();
    vi.restoreAllMocks();
  });

  it("logs each feature once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logSchemaFeatureOffOnce("pick", { code: "42703" });
    logSchemaFeatureOffOnce("pick", { code: "PGRST204" });
    logSchemaFeatureOffOnce("rights", { code: "PGRST205" });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain("pick");
    expect(warn.mock.calls[1][0]).toContain("rights");
  });
});
