import { describe, expect, it } from "vitest";
import { resolveArchivePath } from "./epub-archive-paths";

describe("resolveArchivePath: accepts legitimate archive-relative paths", () => {
  it("resolves an ordinary path relative to an empty base directory", () => {
    expect(resolveArchivePath("", "OEBPS/content.opf")).toEqual({
      safe: true,
      path: "OEBPS/content.opf",
    });
  });

  it("resolves OPS/package.opf and EPUB/package.opf shapes some real EPUB tools use", () => {
    expect(resolveArchivePath("", "OPS/package.opf")).toEqual({ safe: true, path: "OPS/package.opf" });
    expect(resolveArchivePath("", "EPUB/package.opf")).toEqual({ safe: true, path: "EPUB/package.opf" });
  });

  it("resolves a manifest href relative to the OPF's own directory", () => {
    expect(resolveArchivePath("OEBPS", "images/cover.png")).toEqual({
      safe: true,
      path: "OEBPS/images/cover.png",
    });
  });

  it("resolves a legitimate sibling-directory '../' reference that stays inside the archive root", () => {
    expect(resolveArchivePath("OEBPS/Text2", "../Text/chapter.xhtml")).toEqual({
      safe: true,
      path: "OEBPS/Text/chapter.xhtml",
    });
  });

  it("resolves a single '../' that lands back at archive root, not above it", () => {
    expect(resolveArchivePath("OEBPS", "../content.opf")).toEqual({ safe: true, path: "content.opf" });
  });
});

describe("resolveArchivePath: rejects unsafe input", () => {
  it("rejects an empty relative path", () => {
    expect(resolveArchivePath("OEBPS", "")).toEqual({ safe: false });
  });

  it("rejects a NUL-containing path", () => {
    expect(resolveArchivePath("OEBPS", "chapter\0.xhtml")).toEqual({ safe: false });
  });

  it("rejects an absolute path outright, never silently stripping the leading slash", () => {
    expect(resolveArchivePath("OEBPS", "/etc/passwd")).toEqual({ safe: false });
    expect(resolveArchivePath("", "/OEBPS/content.opf")).toEqual({ safe: false });
  });

  it("rejects a traversal that escapes above the archive root entirely", () => {
    expect(resolveArchivePath("OEBPS", "../../../etc/passwd")).toEqual({ safe: false });
    expect(resolveArchivePath("", "../../etc/passwd")).toEqual({ safe: false });
  });

  it("rejects a path that normalizes to exactly the parent-directory marker", () => {
    expect(resolveArchivePath("OEBPS", "..")).toEqual({ safe: false });
  });

  it("rejects a path that normalizes to the current-directory marker when resolved from an empty base directory (denotes no real file)", () => {
    expect(resolveArchivePath("", ".")).toEqual({ safe: false });
  });
});
