import { describe, expect, it } from "vitest";
import {
  MAXIMUM_DISCOUNT_MAX_USES,
  discountExpiryDisplayDate,
  discountExpiryInstant,
  parseMaxUses,
} from "./discount-code-limits";

describe("parseMaxUses", () => {
  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["   ", null],
  ])("%j means no limit", (raw, expected) => {
    expect(parseMaxUses(raw)).toEqual({ ok: true, maxUses: expected });
  });

  it.each([
    ["1", 1],
    [" 50 ", 50],
    ["007", 7],
    ["100000", MAXIMUM_DISCOUNT_MAX_USES],
  ])("%j is %d uses", (raw, expected) => {
    expect(parseMaxUses(raw)).toEqual({ ok: true, maxUses: expected });
  });

  it.each(["0", "000", "100001", "999999", "1000000", "-1", "+5", "1.5", "1,5", "1e3", "0x10", "1 000", "ten", "5 uses"])(
    "%j is refused",
    (raw) => {
      expect(parseMaxUses(raw)).toEqual({ ok: false });
    },
  );

  it("a File is refused", () => {
    expect(parseMaxUses(new File(["5"], "v.txt"))).toEqual({ ok: false });
  });
});

describe("discountExpiryInstant", () => {
  it("winter: the picked day ends at midnight Albania time (UTC+1)", () => {
    expect(discountExpiryInstant("2026-11-01")).toBe("2026-11-01T23:00:00.000Z");
  });

  it("summer: the picked day ends at midnight Albania time (UTC+2)", () => {
    expect(discountExpiryInstant("2026-07-10")).toBe("2026-07-10T22:00:00.000Z");
  });

  it("the days the clocks change use the offset in force at the next midnight", () => {
    // Clocks go forward on Sunday 2027-03-28 and back on Sunday 2026-10-25.
    expect(discountExpiryInstant("2027-03-27")).toBe("2027-03-27T23:00:00.000Z");
    expect(discountExpiryInstant("2027-03-28")).toBe("2027-03-28T22:00:00.000Z");
    expect(discountExpiryInstant("2026-10-24")).toBe("2026-10-24T22:00:00.000Z");
    expect(discountExpiryInstant("2026-10-25")).toBe("2026-10-25T23:00:00.000Z");
  });

  it("month and year ends roll over", () => {
    expect(discountExpiryInstant("2026-12-31")).toBe("2026-12-31T23:00:00.000Z");
    expect(discountExpiryInstant("2028-02-29")).toBe("2028-02-29T23:00:00.000Z");
  });

  it.each(["", "2026-02-30", "2026-13-01", "2027-02-29", "26-11-01", "2026-11-1", "2026-11-01T00:00", "tomorrow"])(
    "%j is not a date",
    (raw) => {
      expect(discountExpiryInstant(raw)).toBeNull();
    },
  );
});

describe("discountExpiryDisplayDate", () => {
  it("shows the picked day for a new code, in winter and in summer", () => {
    expect(discountExpiryDisplayDate("2026-11-01T23:00:00.000Z")).toBe(
      "1 nëntor 2026",
    );
    expect(discountExpiryDisplayDate("2026-07-10T22:00:00.000Z")).toBe(
      "10 korrik 2026",
    );
  });

  it("shows the same day as before for a code stored at midnight UTC", () => {
    expect(discountExpiryDisplayDate("2026-11-01T00:00:00+00:00")).toBe(
      "1 nëntor 2026",
    );
  });
});
