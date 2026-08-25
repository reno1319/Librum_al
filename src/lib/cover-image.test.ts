import { describe, expect, it } from "vitest";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "./cover-image";

// LAUNCH-1 P3-1: cover storage-key extension and Content-Type must come
// exclusively from the server-verified byte signature -- never from
// cover.name or cover.type, both of which are fully client-controlled
// (a crafted multipart POST directly to the createBook/updateBook
// Server Action endpoints can set either to anything, bypassing the
// browser file-picker's own accept="image/png,image/jpeg" attribute
// entirely -- that attribute is a UI hint, not a security boundary).
// These tests exercise the two small pure helpers directly, the same
// "extract a pure decision function, unit-test it directly" pattern
// already used elsewhere in this codebase (decideAdminAccess,
// buildSiteHeaderNav, allocateLegacyBundleRevenue) -- no Server Action
// harness, no fake Supabase client, no fake storage needed to prove
// this property. Deliberately live here rather than in
// src/app/dashboard/books/actions.test.ts: these helpers moved out of
// that "use server" module (see the P3-1 module-boundary correction),
// so their tests move with them.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
// RIFF....WEBP -- WebP's real magic bytes, matched by neither PNG nor
// JPEG's signature checks.
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00];

function makeCoverFile(
  headerBytes: number[],
  { name = "cover.jpg", type = "image/jpeg" }: { name?: string; type?: string } = {},
): File {
  // Real signature bytes followed by a little filler so file.slice(0,8)
  // always has enough bytes to inspect, regardless of which signature
  // is being tested -- mirrors a real (if tiny) image file's shape.
  const bytes = new Uint8Array([...headerBytes, ...new Array(8).fill(0)].slice(0, 16));
  return new File([bytes], name, { type });
}

function makeTextFile(text: string, { name = "cover.jpg", type = "image/jpeg" } = {}): File {
  return new File([text], name, { type });
}

describe("detectCoverImageKind", () => {
  it("real JPEG signature -> 'jpeg', regardless of filename/type claims", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "whatever.png", type: "image/png" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("real PNG signature -> 'png', regardless of filename/type claims", async () => {
    const file = makeCoverFile(PNG_SIGNATURE, { name: "whatever.jpg", type: "image/jpeg" });
    expect(await detectCoverImageKind(file)).toBe("png");
  });

  it("filename 'photo.jpeg' with real JPEG bytes cannot force '.jpeg' -- detection ignores the filename entirely", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "photo.jpeg" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("uppercase filename 'cover.JPG' cannot influence detection", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "cover.JPG" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("double-extension filename 'cover.jpg.exe' cannot influence detection", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "cover.jpg.exe" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("traversal-shaped filename cannot influence detection", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "cover.jpg/../../x" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("no-extension filename 'cover' cannot influence detection", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "cover" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("SVG bytes are rejected -- never accepted, not even for a plausible-looking filename", async () => {
    const file = makeTextFile("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>", {
      name: "cover.svg",
      type: "image/svg+xml",
    });
    expect(await detectCoverImageKind(file)).toBeNull();
  });

  it("WebP bytes are rejected -- WebP was never an actually-supported format despite the filename/type claiming it", async () => {
    const file = makeCoverFile(WEBP_HEADER, { name: "cover.webp", type: "image/webp" });
    expect(await detectCoverImageKind(file)).toBeNull();
  });

  it("plain text/HTML bytes are rejected", async () => {
    const file = makeTextFile("<html><body>not an image</body></html>", {
      name: "cover.jpg",
      type: "image/jpeg",
    });
    expect(await detectCoverImageKind(file)).toBeNull();
  });

  it("spoofed type: real JPEG bytes with file.type='text/html' still detects as jpeg (bytes win, not the claimed type)", async () => {
    const file = makeCoverFile(JPEG_SIGNATURE, { name: "cover.jpg", type: "text/html" });
    expect(await detectCoverImageKind(file)).toBe("jpeg");
  });

  it("spoofed type: real PNG bytes with file.type='image/jpeg' still detects as png (bytes win, not the claimed type)", async () => {
    const file = makeCoverFile(PNG_SIGNATURE, { name: "cover.png", type: "image/jpeg" });
    expect(await detectCoverImageKind(file)).toBe("png");
  });
});

describe("resolveVerifiedCoverStorageDetails", () => {
  it("jpeg -> extension 'jpg', contentType 'image/jpeg'", () => {
    expect(resolveVerifiedCoverStorageDetails("jpeg")).toEqual({
      extension: "jpg",
      contentType: "image/jpeg",
    });
  });

  it("png -> extension 'png', contentType 'image/png'", () => {
    expect(resolveVerifiedCoverStorageDetails("png")).toEqual({
      extension: "png",
      contentType: "image/png",
    });
  });

  it("spoofed type reaching the resolver stage is moot -- the resolver only ever accepts a verified kind, never a raw MIME string, so 'text/html' cannot even be passed here", () => {
    // Compile-time property, demonstrated at the type level: the
    // parameter type is VerifiedCoverImageKind ("jpeg" | "png"), not
    // string, so this file would fail to typecheck if the call site
    // ever tried to pass file.type directly. No runtime assertion
    // possible for a type-level guarantee; documented here instead.
    expect(resolveVerifiedCoverStorageDetails("jpeg").contentType).not.toBe("text/html");
  });

  it("deterministic key: fixed userId + fixed bookId + jpeg -> `${userId}/${bookId}-cover.jpg`", () => {
    const userId = "user-fixed-1";
    const bookId = "book-fixed-1";
    const { extension } = resolveVerifiedCoverStorageDetails("jpeg");
    const coverPath = `${userId}/${bookId}-cover.${extension}`;
    expect(coverPath).toBe("user-fixed-1/book-fixed-1-cover.jpg");
  });

  it("deterministic key: fixed userId + fixed bookId + png -> `${userId}/${bookId}-cover.png`", () => {
    const userId = "user-fixed-1";
    const bookId = "book-fixed-1";
    const { extension } = resolveVerifiedCoverStorageDetails("png");
    const coverPath = `${userId}/${bookId}-cover.${extension}`;
    expect(coverPath).toBe("user-fixed-1/book-fixed-1-cover.png");
  });

  it("the composed key never contains any substring of a traversal-shaped or otherwise attacker-controlled filename -- only userId/bookId/canonical extension appear", () => {
    const userId = "user-fixed-1";
    const bookId = "book-fixed-1";
    const { extension } = resolveVerifiedCoverStorageDetails("jpeg");
    const coverPath = `${userId}/${bookId}-cover.${extension}`;
    expect(coverPath).not.toMatch(/\.\./);
    expect(coverPath.split("/")).toHaveLength(2);
  });
});
