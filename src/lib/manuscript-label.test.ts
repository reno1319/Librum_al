import { describe, expect, it } from "vitest";
import { getManuscriptLabel } from "./manuscript-label";

describe("getManuscriptLabel", () => {
  it("names a stored .epub as an EPUB file, never by its storage name", () => {
    expect(getManuscriptLabel("author-id/26525d0c-1111-4111-8111-111111111111.epub")).toBe("skedar EPUB");
  });

  it("treats an upper-case .EPUB extension the same", () => {
    expect(getManuscriptLabel("author-id/BOOK.EPUB")).toBe("skedar EPUB");
  });

  it("calls any other extension just a file", () => {
    expect(getManuscriptLabel("author-id/book.docx")).toBe("skedar");
  });

  it("calls a name with no extension just a file", () => {
    expect(getManuscriptLabel("author-id/manuscript")).toBe("skedar");
  });

  it("returns null for an empty path (no manuscript on file)", () => {
    expect(getManuscriptLabel("")).toBeNull();
  });

  it("returns null for a null or missing path (no manuscript on file)", () => {
    expect(getManuscriptLabel(null)).toBeNull();
    expect(getManuscriptLabel(undefined)).toBeNull();
  });
});
