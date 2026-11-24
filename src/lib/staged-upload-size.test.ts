import { describe, expect, it, vi } from "vitest";
import { checkStagedUploadSize } from "./staged-upload-size";

const MB5 = 5 * 1024 * 1024;

describe("checkStagedUploadSize (G2 c2)", () => {
  it("over the limit by Storage's stored size: too_large", async () => {
    const info = vi.fn(async () => ({ data: { size: MB5 + 1 }, error: null }));
    expect(await checkStagedUploadSize({ info }, "u/tmp/x.jpg", MB5)).toBe("too_large");
    expect(info).toHaveBeenCalledWith("u/tmp/x.jpg");
  });

  it("at or under the limit: ok", async () => {
    expect(await checkStagedUploadSize({ info: async () => ({ data: { size: MB5 }, error: null }) }, "p", MB5)).toBe("ok");
    expect(await checkStagedUploadSize({ info: async () => ({ data: { size: 0 }, error: null }) }, "p", MB5)).toBe("ok");
  });

  it("an error, no size, a bad size, a throw or no info method: unknown (the caller falls back to the byte check)", async () => {
    expect(await checkStagedUploadSize({ info: async () => ({ data: null, error: { message: "x" } }) }, "p", MB5)).toBe("unknown");
    expect(await checkStagedUploadSize({ info: async () => ({ data: {}, error: null }) }, "p", MB5)).toBe("unknown");
    expect(await checkStagedUploadSize({ info: async () => ({ data: { size: Number.NaN }, error: null }) }, "p", MB5)).toBe("unknown");
    expect(await checkStagedUploadSize({ info: async () => { throw new Error("net"); } }, "p", MB5)).toBe("unknown");
    expect(await checkStagedUploadSize({}, "p", MB5)).toBe("unknown");
  });
});
