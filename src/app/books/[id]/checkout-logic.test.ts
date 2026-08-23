import { describe, expect, it } from "vitest";
import { toStripeExpiresAtSeconds } from "./checkout-logic";

describe("toStripeExpiresAtSeconds", () => {
  it("floors a sub-second timestamp down to the previous whole second", () => {
    // 700ms into the second -- flooring must discard the fraction, not
    // round it, so the result is the START of that second, not the next
    // one.
    const seconds = toStripeExpiresAtSeconds("2026-08-24T09:00:00.700Z");
    expect(seconds).toBe(Date.parse("2026-08-24T09:00:00.000Z") / 1000);
  });

  it("proves the invariant directly: the result is never later than the true instant", () => {
    const cases = [
      "2026-08-24T09:00:00.000Z",
      "2026-08-24T09:00:00.001Z",
      "2026-08-24T09:00:00.499Z",
      "2026-08-24T09:00:00.500Z",
      "2026-08-24T09:00:00.999Z",
      "2026-01-01T00:00:00.123Z",
    ];
    for (const iso of cases) {
      const trueInstantSeconds = Date.parse(iso) / 1000;
      const result = toStripeExpiresAtSeconds(iso);
      expect(result).toBeLessThanOrEqual(trueInstantSeconds);
    }
  });

  it("would be violated by Math.round -- documents why floor, not round, is required", () => {
    const iso = "2026-08-24T09:00:00.700Z";
    const ms = Date.parse(iso);
    const floored = Math.floor(ms / 1000);
    const rounded = Math.round(ms / 1000);
    // .700 rounds UP to the next second -- strictly later than the true
    // instant, which would violate stripe_expires_at <= db cutoff.
    expect(rounded).toBeGreaterThan(ms / 1000);
    expect(floored).toBeLessThanOrEqual(ms / 1000);
    expect(toStripeExpiresAtSeconds(iso)).toBe(floored);
    expect(toStripeExpiresAtSeconds(iso)).not.toBe(rounded);
  });

  it("returns whole seconds already unchanged (the only equality case)", () => {
    const iso = "2026-08-24T09:00:00.000Z";
    expect(toStripeExpiresAtSeconds(iso)).toBe(Date.parse(iso) / 1000);
  });
});
