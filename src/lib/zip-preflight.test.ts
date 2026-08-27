import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { preflightZipEntries } from "./zip-preflight";

const LIMITS = { maxEntries: 100, maxTotalUncompressedBytes: 10 * 1024 * 1024 };

describe("preflightZipEntries", () => {
  it("accepts an ordinary small ZIP and reports correct uncompressed sizes", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "hello world");
    zip.file("b.txt", "goodbye world");
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const result = preflightZipEntries(bytes, LIMITS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries).toHaveLength(2);
    const a = result.entries.find((e) => e.name === "a.txt");
    expect(a?.uncompressedSize).toBe("hello world".length);
  });

  it("rejects a non-ZIP buffer", () => {
    const result = preflightZipEntries(Buffer.from("not a zip at all"), LIMITS);
    expect(result).toEqual({ ok: false, reason: "not_a_zip" });
  });

  it("rejects a ZIP with more entries than the configured maximum", async () => {
    const zip = new JSZip();
    for (let i = 0; i < 150; i++) {
      zip.file(`file-${i}.txt`, "x");
    }
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const result = preflightZipEntries(bytes, { maxEntries: 100, maxTotalUncompressedBytes: 10 * 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it("rejects a ZIP whose declared aggregate uncompressed size exceeds the limit, even though the compressed file itself is small (the actual zip-bomb shape)", async () => {
    const zip = new JSZip();
    // Highly repetitive content compresses extremely well -- this is
    // exactly the zip-bomb shape the preflight exists to catch: a
    // small compressed download that expands to something huge. 2MB
    // of a single repeated byte compresses to a tiny fraction of that.
    const bombContent = Buffer.alloc(2 * 1024 * 1024, 0);
    zip.file("bomb.bin", bombContent, { compression: "DEFLATE", compressionOptions: { level: 9 } });
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    // Prove the compressed archive itself stays small -- the whole
    // point of this test.
    expect(bytes.length).toBeLessThan(50 * 1024);

    const result = preflightZipEntries(bytes, { maxEntries: 100, maxTotalUncompressedBytes: 1024 * 1024 });
    expect(result).toEqual({ ok: false, reason: "too_large_uncompressed" });
  });

  it("accepts a ZIP whose total uncompressed size is within the limit", async () => {
    const zip = new JSZip();
    zip.file("small.bin", Buffer.alloc(1024, 1));
    const bytes = await zip.generateAsync({ type: "nodebuffer" });

    const result = preflightZipEntries(bytes, { maxEntries: 100, maxTotalUncompressedBytes: 10 * 1024 * 1024 });
    expect(result.ok).toBe(true);
  });
});
