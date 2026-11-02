import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import {
  documentText,
  hasMentions,
  listedMentions,
  MAX_LISTED_FILES,
  scanEpubForOutsideMentions,
} from "./epub-outside-mentions";
import { outsideMentionMessages } from "./outside-mentions";

async function epub(files: Record<string, string>): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip");
  zip.file("META-INF/container.xml", "<container/>");
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return zip.generateAsync({ type: "uint8array" });
}

const page = (body: string, head = "<title>t</title>") =>
  `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head>${head}</head><body>${body}</body></html>`;

describe("documentText (BD3 patch 3)", () => {
  it("keeps visible text and link addresses, drops head, script, style and comments", () => {
    const text = documentText(
      page(
        `<p>Lexo &amp; shiko <a href="mailto:a@b.al">këtu</a></p><!-- Kindle --><script>Kobo</script><style>.x{}/* Wattpad */</style><p>Fund&#33;</p>`,
        "<title>Smashwords Edition</title>",
      ),
    );
    expect(text).toContain("Lexo & shiko");
    expect(text).toContain("a@b.al");
    expect(text).toContain("Fund!");
    for (const hidden of ["Kindle", "Kobo", "Wattpad", "Smashwords"]) expect(text).not.toContain(hidden);
  });

  it("does not take <header> for <head>", () => {
    expect(documentText("<header>Amazon</header>")).toContain("Amazon");
  });

  it("a long run of '<' with no '>' stays linear (audit r1, N2)", () => {
    const started = Date.now();
    documentText(`<p>x</p>${"<".repeat(400_000)}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("an unclosed comment or script drops the rest, in linear time", () => {
    expect(documentText("<p>para</p><!-- Kindle <p>Kobo</p>")).not.toContain("Kobo");
    const many = "<script ".repeat(200_000);
    const started = Date.now();
    documentText(`<p>x</p>${many}`);
    const manyComments = "<!-- ".repeat(200_000);
    documentText(`<p>x</p>${manyComments}`);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("scanEpubForOutsideMentions (BD3 patch 3)", () => {
  it("finds stores, emails and phones across the book's files, with the files they are in", async () => {
    const bytes = await epub({
      "OEBPS/ch1.xhtml": page("<p>Një histori pa asgjë.</p>"),
      "OEBPS/ch2.xhtml": page('<p>Na gjeni në <a href="https://www.amazon.com/dp/1">Amazon</a>.</p>'),
      "OEBPS/end.xhtml": page("<p>Shkruani: autori@example.com ose 069 123 4567. Edhe support@librum.al.</p>"),
      "OEBPS/style.css": "/* Kobo */",
    });
    const scan = await scanEpubForOutsideMentions(bytes);
    expect(scan).not.toBeNull();
    expect(hasMentions(scan)).toBe(true);
    expect(scan!.mentions).toEqual({ stores: ["Amazon"], emails: ["autori@example.com"], phones: ["069 123 4567"] });
    expect(scan!.files).toEqual(["OEBPS/ch2.xhtml", "OEBPS/end.xhtml"]);
  });

  it("a clean book has no mentions", async () => {
    const scan = await scanEpubForOutsideMentions(await epub({ "a.xhtml": page("<p>Deti ishte i qetë.</p>") }));
    expect(scan).toEqual({ mentions: { stores: [], emails: [], phones: [] }, files: [] });
    expect(hasMentions(scan)).toBe(false);
  });

  it("an archive it cannot read gives null, never throws", async () => {
    expect(await scanEpubForOutsideMentions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(hasMentions(null)).toBe(false);
  });

  it("lists every file a mention is in, up to MAX_LISTED_FILES, and at most five addresses for the author", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_LISTED_FILES + 5; i++) {
      files[`c${String(i).padStart(2, "0")}.xhtml`] = page(`<p>Shkruani te person${i}@example.com, Kindle.</p>`);
    }
    const scan = await scanEpubForOutsideMentions(await epub(files));
    expect(scan!.mentions.stores).toEqual(["Kindle"]);
    expect(scan!.mentions.emails).toHaveLength(MAX_LISTED_FILES + 5);
    expect(scan!.files).toHaveLength(MAX_LISTED_FILES);
    expect(listedMentions(scan!).emails).toHaveLength(5);
  });

  it("the EPUB wording tells the author to fix the EPUB, not Word", () => {
    const m = outsideMentionMessages({ stores: ["Kobo"], emails: ["a@b.al"], phones: [] }, "epub");
    expect(m.store).toContain("nga skedari EPUB");
    expect(m.store).not.toContain("Word");
    expect(m.contact).toContain("nga skedari EPUB");
    // 3c: no reviewer check, so the warning promises none (audit r1, N5).
    expect(m.store).not.toContain("recensuesi");
    expect(outsideMentionMessages({ stores: ["Kobo"], emails: [], phones: [] }).store).not.toContain("recensuesi");
    expect(outsideMentionMessages({ stores: ["Kobo"], emails: [], phones: [] }).store).toContain("në Word");
  });
});
