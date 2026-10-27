import sharp, { type Color } from "sharp";
import { describe, expect, it } from "vitest";
import {
  BLOG_COVER_SIZE,
  BOOK_COVER_SIZE,
  IMAGE_CACHE_CONTROL_SECONDS,
  PEN_NAME_PHOTO_SIZE,
  shrinkImageToJpeg,
} from "./cover-resize";

const shrinkCoverToJpeg = (bytes: Buffer) => shrinkImageToJpeg(bytes, BOOK_COVER_SIZE);

// COVERS-1: real sharp, real images -- no mocks.

function solid(width: number, height: number, background: Color, channels: 3 | 4 = 3) {
  return sharp({ create: { width, height, channels, background } });
}

describe("shrinkImageToJpeg", () => {
  it("shrinks a large PNG to an 800px-wide JPEG, keeping the 2:3 shape", async () => {
    const input = await solid(2000, 3000, "#1e3a32").png().toBuffer();
    const out = await shrinkCoverToJpeg(input);
    const meta = await sharp(out!).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBe(800);
    expect(meta.height).toBe(1200);
  });

  it("never enlarges a cover that is already small", async () => {
    const input = await solid(300, 450, "#ffffff").jpeg().toBuffer();
    const meta = await sharp((await shrinkCoverToJpeg(input))!).metadata();
    expect([meta.width, meta.height]).toEqual([300, 450]);
  });

  it("turns a sideways phone photo the right way up and drops EXIF data", async () => {
    // Stored 300 wide x 200 tall with orientation 6 ("rotate 90° to view").
    const input = await solid(300, 200, "#808080")
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD0: { Make: "PhoneCo", Model: "Camera 1" } })
      .toBuffer();
    const meta = await sharp((await shrinkCoverToJpeg(input))!).metadata();
    expect([meta.width, meta.height]).toEqual([200, 300]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
  });

  it("fills a transparent PNG background with white", async () => {
    const input = await solid(10, 10, { r: 0, g: 0, b: 0, alpha: 0 }, 4).png().toBuffer();
    const { data, info } = await sharp((await shrinkCoverToJpeg(input))!).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect(data[0]).toBeGreaterThan(250);
  });

  it("returns null for bytes that only look like an image", async () => {
    const pngSignatureThenJunk = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(512, 7),
    ]);
    expect(await shrinkCoverToJpeg(pngSignatureThenJunk)).toBeNull();
    expect(await shrinkCoverToJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBeNull();
  });

  it("refuses a decompression bomb (a tiny file declaring a huge canvas)", async () => {
    // 12000 x 12000 = 144M pixels, above the 100M limit, but tiny on disk.
    const input = await solid(12000, 12000, "#000000").png({ compressionLevel: 9 }).toBuffer();
    expect(input.length).toBeLessThan(5 * 1024 * 1024);
    expect(await shrinkCoverToJpeg(input)).toBeNull();
  });

  it("shrinks a blog cover to 1400px wide", async () => {
    const input = await solid(3000, 2000, "#1e3a32").jpeg().toBuffer();
    const meta = await sharp((await shrinkImageToJpeg(input, BLOG_COVER_SIZE))!).metadata();
    expect([meta.width, meta.height]).toEqual([1400, 933]);
  });

  it("fits a pen name photo inside 400x400, keeping its shape", async () => {
    const input = await solid(1200, 1600, "#1e3a32").png().toBuffer();
    const meta = await sharp((await shrinkImageToJpeg(input, PEN_NAME_PHOTO_SIZE))!).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 300, 400]);
  });

  it("caches for one week", () => {
    expect(IMAGE_CACHE_CONTROL_SECONDS).toBe("604800");
  });
});
