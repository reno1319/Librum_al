import { describe, expect, it } from "vitest";
import {
  blogPublishState,
  canBeScheduled,
  formatTiranaDateTime,
  instantToTiranaInputs,
  tiranaLocalToInstant,
} from "./blog-schedule";

const NOW = new Date("2026-11-19T12:00:00Z");

describe("blogPublishState", () => {
  it("draft, scheduled (future time) and published (time passed)", () => {
    expect(blogPublishState({ status: "draft", published_at: null }, NOW)).toBe("draft");
    expect(blogPublishState({ status: "draft", published_at: "2026-01-01T00:00:00Z" }, NOW)).toBe("draft");
    expect(blogPublishState({ status: "published", published_at: "2026-11-19T12:00:01Z" }, NOW)).toBe("scheduled");
    expect(blogPublishState({ status: "published", published_at: "2026-11-19T12:00:00Z" }, NOW)).toBe("published");
    expect(blogPublishState({ status: "published", published_at: "2026-11-01T00:00:00Z" }, NOW)).toBe("published");
  });
});

describe("canBeScheduled", () => {
  it("only a never-live draft or a not-yet-live scheduled post", () => {
    expect(canBeScheduled({ status: "draft", published_at: null }, NOW)).toBe(true);
    expect(canBeScheduled({ status: "published", published_at: "2026-11-20T08:00:00Z" }, NOW)).toBe(true);
    expect(canBeScheduled({ status: "draft", published_at: "2026-11-01T08:00:00Z" }, NOW)).toBe(false);
    expect(canBeScheduled({ status: "published", published_at: "2026-11-01T08:00:00Z" }, NOW)).toBe(false);
  });
});

describe("tiranaLocalToInstant", () => {
  it("winter (UTC+1) and summer (UTC+2)", () => {
    expect(tiranaLocalToInstant("2026-11-21", "09:00")?.toISOString()).toBe("2026-11-21T08:00:00.000Z");
    expect(tiranaLocalToInstant("2026-07-01", "09:00")?.toISOString()).toBe("2026-07-01T07:00:00.000Z");
  });
  it("the autumn repeated hour picks a real instant", () => {
    const i = tiranaLocalToInstant("2026-10-25", "02:30");
    expect(i).not.toBeNull();
    expect(instantToTiranaInputs(i!.toISOString())).toEqual({ date: "2026-10-25", time: "02:30" });
  });
  it("the spring missing hour, bad text and impossible dates give null", () => {
    expect(tiranaLocalToInstant("2026-03-29", "02:30")).toBeNull();
    expect(tiranaLocalToInstant("2026-02-30", "09:00")).toBeNull();
    expect(tiranaLocalToInstant("21.11.2026", "09:00")).toBeNull();
    expect(tiranaLocalToInstant("2026-11-21", "9:00")).toBeNull();
    expect(tiranaLocalToInstant("2026-11-21", "24:00")).toBeNull();
    expect(tiranaLocalToInstant("", "")).toBeNull();
  });
});

describe("Tirana display", () => {
  it("round-trips the inputs and formats in Tirana time", () => {
    expect(instantToTiranaInputs("2026-11-21T08:00:00Z")).toEqual({ date: "2026-11-21", time: "09:00" });
    expect(formatTiranaDateTime("2026-11-21T08:00:00Z")).toBe("Nov 21, 2026, 09:00");
  });
});
