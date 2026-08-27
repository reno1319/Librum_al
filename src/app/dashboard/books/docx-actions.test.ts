import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { packageEpub } from "./docx-actions";

// LIBRUM 2.0 PRODUCT-5 PRE-COMMIT CORRECTION: packageEpub() is a plain
// async function (its "use server" directive doesn't block a direct
// unit-test import, same as any other Server Action in this codebase)
// -- these tests pin the exact title/author fallback behavior the
// correction brief requires: New Book's real title (once known) and
// Edit Book's already-known title must both reach dc:title untouched,
// with the placeholder used only when nothing real is available yet.
const SECTIONS = [{ heading: null, html: "<p>Body text.</p>" }];

describe("packageEpub", () => {
  it("uses the real, provided book title and author verbatim in the generated EPUB's metadata", async () => {
    const result = await packageEpub("The Maltese Falcon", "Dashiell Hammett", SECTIONS, []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const bytes = Buffer.from(result.epubBase64, "base64");
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>The Maltese Falcon</dc:title>");
    expect(opf).toContain("<dc:creator>Dashiell Hammett</dc:creator>");
  });

  it("falls back to an explicit placeholder only when no real title/author is available yet -- never fabricated from manuscript content", async () => {
    const result = await packageEpub("", "", SECTIONS, []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const bytes = Buffer.from(result.epubBase64, "base64");
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>Untitled manuscript</dc:title>");
    expect(opf).toContain("<dc:creator>Unknown author</dc:creator>");
  });

  it("trims incidental whitespace-only titles the same way as an empty one", async () => {
    const result = await packageEpub("   ", "   ", SECTIONS, []);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const bytes = Buffer.from(result.epubBase64, "base64");
    const zip = await JSZip.loadAsync(bytes);
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    expect(opf).toContain("<dc:title>Untitled manuscript</dc:title>");
  });
});
