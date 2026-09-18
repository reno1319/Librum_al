import { describe, expect, it } from "vitest";
import { resolveMaintenanceMode } from "./maintenance-mode";

// ALL-CUTOVER APP-A: mirrors the exhaustive-case style already
// established for resolveCheckoutRegime (src/lib/checkout-regime.test.ts)
// -- an unrecognized/absent env value must never accidentally resolve
// to maintenance being active, and no near-miss on the one accepted
// literal is coerced into it either.
describe("resolveMaintenanceMode", () => {
  it("the exact literal \"active\" resolves to true", () => {
    expect(resolveMaintenanceMode("active")).toBe(true);
  });

  it("missing (undefined) resolves to false", () => {
    expect(resolveMaintenanceMode(undefined)).toBe(false);
  });

  it("empty string resolves to false", () => {
    expect(resolveMaintenanceMode("")).toBe(false);
  });

  it("whitespace-only resolves to false", () => {
    expect(resolveMaintenanceMode("   ")).toBe(false);
  });

  it("whitespace is NOT trimmed -- a leading/trailing space around the literal is unrecognized and resolves to false", () => {
    expect(resolveMaintenanceMode(" active")).toBe(false);
    expect(resolveMaintenanceMode("active ")).toBe(false);
  });

  it("case sensitivity is explicit -- any casing other than the exact lowercase literal resolves to false", () => {
    expect(resolveMaintenanceMode("Active")).toBe(false);
    expect(resolveMaintenanceMode("ACTIVE")).toBe(false);
  });

  it("an unrecognized value resolves to false", () => {
    expect(resolveMaintenanceMode("on")).toBe(false);
    expect(resolveMaintenanceMode("true")).toBe(false);
    expect(resolveMaintenanceMode("1")).toBe(false);
    expect(resolveMaintenanceMode("enabled")).toBe(false);
  });
});
