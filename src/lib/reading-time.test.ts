import { describe, expect, it } from "vitest";
import { readingTimeText } from "@/lib/reading-time";

describe("readingTimeText (Renato 11-10: minutes under one hour)", () => {
  it("shows minutes under one hour, at least 1", () => {
    expect(readingTimeText(1)).toBe("~1 min");
    expect(readingTimeText(165)).toBe("~1 min");
    expect(readingTimeText(1000)).toBe("~4 min");
    expect(readingTimeText(14_874)).toBe("~59 min");
  });

  it("switches to whole hours from 60 minutes", () => {
    expect(readingTimeText(14_875)).toBe("~1 orë");
    expect(readingTimeText(15_000)).toBe("~1 orë");
    expect(readingTimeText(52_500)).toBe("~4 orë");
    expect(readingTimeText(100_000)).toBe("~7 orë");
  });

  it("no tile for a missing, zero, negative or broken count", () => {
    for (const bad of [null, undefined, 0, -5, 1.5, "1000", Number.NaN]) {
      expect(readingTimeText(bad)).toBeNull();
    }
  });
});
