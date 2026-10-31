import { describe, expect, it, vi } from "vitest";
import { approvalStillValid, approvalTickState, createPreviewCache, shouldBlockSubmit, submittablePath } from "./manuscript-approval";

const P = "author-1/tmp/epub/x.epub";

describe("submittablePath (answer 6a)", () => {
  it("gives the form a Word build only once the author confirmed it", () => {
    expect(submittablePath("docx", P, false)).toBeNull();
    expect(submittablePath("docx", P, true)).toBe(P);
    expect(submittablePath("docx", null, true)).toBeNull();
  });

  it("leaves author-made EPUB uploads as before (7b)", () => {
    expect(submittablePath("epub", P, false)).toBe(P);
    expect(submittablePath("epub", null, false)).toBeNull();
  });
});

describe("shouldBlockSubmit", () => {
  it("stops a submit of a ready, unconfirmed Word build", () => {
    expect(shouldBlockSubmit("docx", P, false, 0)).toBe(true);
    expect(shouldBlockSubmit("docx", P, true, 0)).toBe(false);
  });

  it("lets the in-flight guard wait first, and never blocks EPUB or an empty field", () => {
    expect(shouldBlockSubmit("docx", P, false, 1)).toBe(false);
    expect(shouldBlockSubmit("epub", P, false, 0)).toBe(false);
    expect(shouldBlockSubmit("docx", null, false, 0)).toBe(false);
  });
});

describe("approvalTickState (audit F3)", () => {
  it("is open only after the preview loaded, with nothing pending and no rebuild running", () => {
    expect(approvalTickState({ previewSeen: true, pendingChanges: 0, applying: false })).toEqual({ disabled: false, reason: null });
    expect(approvalTickState({ previewSeen: false, pendingChanges: 0, applying: false }).disabled).toBe(true);
    const pending = approvalTickState({ previewSeen: true, pendingChanges: 2, applying: false });
    expect(pending.disabled).toBe(true);
    expect(pending.reason).toContain("2 ndryshime pa aplikuar");
    expect(approvalTickState({ previewSeen: true, pendingChanges: 1, applying: false }).reason).toContain("1 ndryshim pa aplikuar");
    expect(approvalTickState({ previewSeen: true, pendingChanges: 0, applying: true }).disabled).toBe(true);
  });

  it("takes back an approval when changes are pending or a rebuild runs", () => {
    expect(approvalStillValid(true, 0, false)).toBe(true);
    expect(approvalStillValid(true, 1, false)).toBe(false);
    expect(approvalStillValid(true, 0, true)).toBe(false);
    expect(approvalStillValid(false, 0, false)).toBe(false);
  });
});

describe("createPreviewCache (audit F4)", () => {
  it("downloads a build's preview once across several opens, and again for a new build", async () => {
    const download = vi.fn(async (path: string) => new Blob([path]));
    const cache = createPreviewCache(download);
    await cache.get("a");
    await cache.get("a");
    await cache.get("a");
    expect(download).toHaveBeenCalledTimes(1);
    await cache.get("b");
    await cache.get("b");
    expect(download).toHaveBeenCalledTimes(2);
    cache.clear();
    await cache.get("b");
    expect(download).toHaveBeenCalledTimes(3);
  });

  it("shares one download between opens that overlap, and retries after a failure", async () => {
    let fail = true;
    const download = vi.fn(async () => {
      if (fail) throw new Error("network");
      return new Blob(["x"]);
    });
    const cache = createPreviewCache(download);
    const [a, b] = [cache.get("p"), cache.get("p")];
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    expect(download).toHaveBeenCalledTimes(1);
    fail = false;
    await cache.get("p");
    expect(download).toHaveBeenCalledTimes(2);
  });
});
