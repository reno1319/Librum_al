import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { convertDocxToDocument } from "@/lib/docx-converter";
import { buildDocxBytes, heading, paragraph } from "@/lib/docx-test-fixtures";
import { ENDNOTES_HEADING } from "@/lib/docx-notes";
import { WORD_TEMPLATE_PATH } from "@/lib/word-guide-paths";
import { buildWordTemplate, WORD_TEMPLATE_BLOCKS, WORD_TEMPLATE_CONTENT_TYPE, WORD_TEMPLATE_FILENAME } from "@/lib/word-template";

// BD6: the Librum Word template must convert, through the real
// converter, into exactly the book it shows -- 2 chapters from Heading
// 1, a scene break, a kept footnote, a sub-heading and a two-stanza
// poem -- with no warning and nothing unsure for the author preview
// (Renato's 2a: the template mirrors the converter).

const root = path.join(__dirname, "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BD6: the Librum Word template", () => {
  it("is the same bytes every time (fixed dates, no randomness)", async () => {
    const a = await buildWordTemplate();
    const b = await buildWordTemplate();
    expect(a.equals(b)).toBe(true);
  });

  it("is a .docx with the parts Word expects, and no personal data", async () => {
    const zip = await JSZip.loadAsync(await buildWordTemplate());
    expect(Object.keys(zip.files).sort()).toEqual(
      [
        "[Content_Types].xml",
        "_rels/.rels",
        "docProps/core.xml",
        "word/_rels/document.xml.rels",
        "word/document.xml",
        "word/footnotes.xml",
        "word/settings.xml",
        "word/styles.xml",
      ].sort(),
    );
    const all = (await Promise.all(Object.values(zip.files).map((f) => f.async("string")))).join("\n");
    expect(all).not.toMatch(/@[a-z0-9-]+\./i); // no email address
    expect(all).not.toMatch(/dc:creator|cp:lastModifiedBy|dcterms:created|dcterms:modified/);
    // Word needs the footnotes part declared and its two separator notes,
    // or it offers to "repair" the file (audit r1 M12, M13).
    const types = await zip.file("[Content_Types].xml")!.async("string");
    for (const part of ["document.main", "styles", "settings", "footnotes"]) {
      expect(types).toContain(`ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part}+xml"`);
    }
    const notes = await zip.file("word/footnotes.xml")!.async("string");
    expect(notes).toContain('<w:footnote w:type="separator" w:id="-1">');
    expect(notes).toContain('<w:footnote w:type="continuationSeparator" w:id="0">');
    const settings = await zip.file("word/settings.xml")!.async("string");
    expect(settings).toContain('<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>');
    const rels = await zip.file("word/_rels/document.xml.rels")!.async("string");
    expect(rels).toContain('Target="footnotes.xml"');
    const styles = await zip.file("word/styles.xml")!.async("string");
    // Word's own built-in names, so "Heading 1" is the usual menu entry.
    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>');
    expect(styles).toContain('<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/>');
    expect(styles).toContain('<w:lang w:val="sq-AL"');
    // Every chapter starts on a new page in Word too.
    expect(styles).toMatch(/w:styleId="Heading1">.*?<w:pageBreakBefore\/>.*?<\/w:style>/);
  });

  it("converts into the book it shows, with no warning and no unsure guess", async () => {
    const result = await convertDocxToDocument(await buildWordTemplate(), {}, { preview: true });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.warnings).toEqual([]);
    expect(result.cleanup.applied).toBe(true);
    expect(result.cleanup.chapterSource).toBe("styles");
    expect(result.cleanup.guesses).toEqual([]);
    expect(result.cleanup.sceneBreaks).toBe(1);
    expect(result.cleanup.notes).toEqual({ footnotes: 1, endnotes: 0, dropped: 0 });
    expect(Object.values(result.cleanup.fixes).every((n) => n === 0)).toBe(true);
    expect(result.cleanup.missingLetters).toBeNull();

    expect(result.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2"]);
    expect(result.sections.map((s) => s.heading)).not.toContain(ENDNOTES_HEADING);
    const [one, two] = result.sections.map((s) => s.html);
    expect(one.match(/<p class="scene-break">\* \* \*<\/p>/g)).toHaveLength(1);
    expect(one).toContain("<h2>Një nëntitull</h2>");
    expect(one).toContain('epub:type="noteref"');
    expect(one).toContain('<aside epub:type="footnote"');
    expect(one).toContain("Ky është një shënim shembull.");
    expect(two.match(/<p class="verse">/g)).toHaveLength(2);
    expect(two).toContain("Vargu i parë i strofës,<br/>vargu i dytë poshtë tij,<br/>vargu i tretë e mbyll strofën.");
    // Every example sentence reaches the book, letter for letter.
    const html = result.sections.map((s) => s.html).join("");
    for (const block of WORD_TEMPLATE_BLOCKS) {
      if (block.kind === "text") expect(html).toContain(block.text);
    }
  });

  it("still gives the 2 chapters with the clean-up pass switched off (DOCX_CLEANUP_OFF)", async () => {
    vi.stubEnv("DOCX_CLEANUP_OFF", "1");
    const result = await convertDocxToDocument(await buildWordTemplate());
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.cleanup.applied).toBe(false);
    expect(result.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2"]);
  });

  it("is downloaded from the guide's route as an attachment", async () => {
    const { GET } = await import("@/app/(public)/ndihme/word/shablloni/route");
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(WORD_TEMPLATE_CONTENT_TYPE);
    expect(response.headers.get("Content-Disposition")).toBe(`attachment; filename="${WORD_TEMPLATE_FILENAME}"`);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = Buffer.from(await response.arrayBuffer());
    expect(body.equals(await buildWordTemplate())).toBe(true);
    // The route sits at the path every link uses.
    expect(WORD_TEMPLATE_PATH).toBe("/ndihme/word/shablloni");
  });
});

describe("BD6: the guide's rules, run through the converter (audit r2 N3)", () => {
  const stanza = (...lines: string[]) =>
    `<w:p>${lines.map((l, i) => (i === 0 ? "" : "<w:r><w:br/></w:r>") + `<w:r><w:t>${l}</w:t></w:r>`).join("")}</w:p>`;
  const prose = "Një paragraf i zakonshëm me tekst të mjaftueshëm për të qenë prozë e vërtetë në libër.";

  it("with no Heading 1, several Heading 2 titles become the chapters", async () => {
    const bytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml: [heading(2, "Pjesa e parë"), paragraph(prose), heading(2, "Pjesa e dytë"), paragraph(prose)].join(""),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections.map((s) => s.heading).filter(Boolean)).toEqual(["Pjesa e parë", "Pjesa e dytë"]);
  });

  it("with Heading 1 chapters, a Heading 2 stays a sub-heading", async () => {
    const bytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml: [heading(1, "Kapitulli 1"), paragraph(prose), heading(2, "Nëntitull"), paragraph(prose)].join(""),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.sections.map((s) => s.heading)).toEqual(["Kapitulli 1"]);
    expect(result.sections[0].html).toContain("<h2>Nëntitull</h2>");
  });

  it("a stanza of 3 short lines is a poem; a 2-line stanza keeps its line break but is ordinary text", async () => {
    const bytes = await buildDocxBytes({
      includeStyles: true,
      bodyXml: [heading(1, "Poezi"), stanza("Vargu një,", "vargu dy,", "vargu tre."), stanza("Vargu katër,", "vargu pesë.")].join(""),
    });
    const result = await convertDocxToDocument(bytes);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const html = result.sections[0].html;
    expect(html).toContain('<p class="verse">Vargu një,<br/>vargu dy,<br/>vargu tre.</p>');
    expect(html).toContain("<p>Vargu katër,<br/>vargu pesë.</p>");
  });
});

describe("BD6: the guide's numbers match the converter", () => {
  it("50 MB upload limit, 15 MB per picture and 40 MB of pictures in all", () => {
    expect(read("src/app/(public)/dashboard/books/actions.ts")).toContain("const MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024;");
    const converter = read("src/lib/docx-converter.ts");
    expect(converter).toContain("const MAX_SINGLE_IMAGE_BYTES = 15 * 1024 * 1024;");
    expect(converter).toContain("const MAX_TOTAL_IMAGE_BYTES = 40 * 1024 * 1024;");
    const guide = read("src/app/(public)/ndihme/word/page.tsx");
    expect(guide).toContain("deri në 50 MB");
    expect(guide).toContain("deri në 15 MB secila dhe 40 MB gjithsej");
  });

  it("a poem stanza needs 3+ lines of 60 characters or less on average, as the guide says", () => {
    const structure = read("src/lib/docx-structure.ts");
    expect(structure).toContain("else if (f.lineBreaks >= 2) {");
    expect(structure).toContain('if (avg <= 60) plan(j).style = "verse";');
    expect(read("src/app/(public)/ndihme/word/page.tsx")).toContain("një strofë me të paktën tre vargje të shkurtra");
  });

  it("PNG, JPEG and GIF are the picture types kept", () => {
    expect(read("src/lib/docx-converter.ts")).toContain('mediaType: "image/png" | "image/jpeg" | "image/gif";');
    expect(read("src/app/(public)/ndihme/word/page.tsx")).toContain("në format PNG, JPEG ose GIF");
  });

  it("names the preview buttons exactly as the preview shows them", async () => {
    const preview = read("src/components/ebook-preview.tsx");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: WordGuidePage } = await import("@/app/(public)/ndihme/word/page");
    const text = renderToStaticMarkup(WordGuidePage()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const label of ["Bëje kapitull", "Ky nuk është kapitull"]) {
      expect(preview).toContain(`"${label}"`);
      expect(text).toContain(`“${label}”`);
    }
    for (const label of ["Apliko ndryshimet", "E kontrollova, libri duket mirë"]) {
      expect(preview).toMatch(new RegExp(`^\\s*${label}$`, "m"));
      expect(text).toContain(`“${label}”`);
    }
    expect(text).toContain(`“${ENDNOTES_HEADING}”`);
  });
});
