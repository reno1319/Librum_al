import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { generateEpub, patchEpubMetadata } from "./epub-generator";
import { validateEpubStructure } from "./epub-validation";
import { extractEpubSample } from "./epub-sample";
import {
  EBOOK_COVER_IMAGE_ENTRY,
  EBOOK_COVER_PAGE_ENTRY,
  embedCoverInLibrumEpub,
  isLibrumMadeEpub,
  readLibrumEbookCover,
} from "./epub-cover";

// W7: the cover inside a Librum-made (Word) ebook.

const CONVERSION_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const INPUT = {
  bookId: CONVERSION_ID,
  title: "Libri i provës",
  authorName: "Autor Prove",
  sections: [
    { heading: "Kapitulli 1", html: "<p>Teksti i parë i kapitullit.</p>" },
    { heading: "Kapitulli 2", html: "<p>Teksti i dytë.</p>" },
  ],
  images: [],
};
// Stand-in picture bytes: the module checks only the JPEG start (FF D8 FF)
// and stores the rest as handed.
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const COVER_A = Buffer.concat([JPEG_START, Buffer.from("cover-A-jpeg-bytes")]);
const COVER_B = Buffer.concat([JPEG_START, Buffer.from("cover-B-jpeg-bytes-different")]);

async function librumEpub(): Promise<Buffer> {
  return generateEpub(INPUT);
}

async function readEntry(bytes: Buffer, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file(name);
  if (!entry) throw new Error(`missing ${name}`);
  return entry.async("string");
}

async function directEpub(opfIdentifier: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${opfIdentifier}<dc:title>T</dc:title></metadata><manifest></manifest><spine></spine></package>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("isLibrumMadeEpub", () => {
  it("recognises generateEpub()'s package, also after the title patch", async () => {
    const bytes = await librumEpub();
    expect(await isLibrumMadeEpub(bytes)).toBe(true);
    expect(await isLibrumMadeEpub(await patchEpubMetadata(bytes, "Titull", "Emër"))).toBe(true);
  });

  it("does not recognise a directly uploaded ebook, even one carrying a Librum-looking identifier elsewhere", async () => {
    expect(
      await isLibrumMadeEpub(
        await directEpub(`<dc:identifier id="book-id">urn:librum:book:${CONVERSION_ID}</dc:identifier>`),
      ),
    ).toBe(false);
    expect(await isLibrumMadeEpub(await directEpub(`<dc:identifier id="book-id">urn:isbn:9780000000000</dc:identifier>`))).toBe(false);
  });

  it("does not recognise a Librum layout whose identifier is not urn:librum:book:<uuid>", async () => {
    const zip = await JSZip.loadAsync(await librumEpub());
    const opf = await zip.file("OEBPS/content.opf")!.async("string");
    zip.file("OEBPS/content.opf", opf.replace(`urn:librum:book:${CONVERSION_ID}`, "urn:librum:book:not-a-uuid"));
    expect(await isLibrumMadeEpub(Buffer.from(await zip.generateAsync({ type: "nodebuffer" })))).toBe(false);
  });

  it("treats bytes that are not a ZIP as not Librum-made", async () => {
    expect(await isLibrumMadeEpub(Buffer.from("not a zip at all"))).toBe(false);
  });
});

describe("embedCoverInLibrumEpub", () => {
  it("adds the cover as the first page and as the cover-image, keeping every chapter byte-for-byte", async () => {
    const before = await librumEpub();
    const result = await embedCoverInLibrumEpub(before, { coverJpeg: COVER_A });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opf = await readEntry(result.bytes, "OEBPS/content.opf");
    expect(opf).toContain(
      '<item id="librum-cover-image" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>',
    );
    expect(opf).toContain('<item id="librum-cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>');
    expect(opf).toContain('<meta name="cover" content="librum-cover-image"/>');
    // First in the spine, before chapter 1.
    expect(opf).toMatch(/<spine>\n<itemref idref="librum-cover-page"\/>\n<itemref idref="chapter1"\/>/);

    const zip = await JSZip.loadAsync(result.bytes);
    expect(await zip.file(EBOOK_COVER_IMAGE_ENTRY)!.async("nodebuffer")).toEqual(COVER_A);
    const page = await zip.file(EBOOK_COVER_PAGE_ENTRY)!.async("string");
    expect(page).toContain('<img src="cover.jpg" alt="Libri i provës"/>');
    expect(page).toContain('xml:lang="sq"');

    for (const name of ["OEBPS/chapter-1.xhtml", "OEBPS/chapter-2.xhtml", "OEBPS/nav.xhtml", "OEBPS/styles.css"]) {
      expect(await readEntry(result.bytes, name)).toBe(await readEntry(before, name));
    }
    // Still a valid package for Librum's own checks.
    expect((await validateEpubStructure(result.bytes)).valid).toBe(true);
    // mimetype stays first and stored.
    expect(result.bytes.readUInt16LE(8)).toBe(0);
    expect(result.bytes.subarray(30, 38).toString("ascii")).toBe("mimetype");
  });

  it("swapping again replaces the cover: one cover entry each, newest bytes", async () => {
    const first = await embedCoverInLibrumEpub(await librumEpub(), { coverJpeg: COVER_A });
    if (!first.ok) throw new Error("first embed failed");
    const second = await embedCoverInLibrumEpub(first.bytes, { coverJpeg: COVER_B });
    if (!second.ok) throw new Error("second embed failed");
    const opf = await readEntry(second.bytes, "OEBPS/content.opf");
    expect(opf.split('id="librum-cover-image"').length - 1).toBe(1);
    expect(opf.split('id="librum-cover-page"').length - 1).toBe(1);
    expect(opf.split('idref="librum-cover-page"').length - 1).toBe(1);
    expect(opf.split('<meta name="cover"').length - 1).toBe(1);
    expect(await readLibrumEbookCover(second.bytes)).toEqual(COVER_B);
    // Still recognised as Librum-made after a swap.
    expect(await isLibrumMadeEpub(second.bytes)).toBe(true);
  });

  it("3a: refreshes the title and author name, escaped, and the modified time", async () => {
    const before = await librumEpub();
    const result = await embedCoverInLibrumEpub(before, {
      coverJpeg: COVER_A,
      title: "Ujë & Zjarr <2>",
      authorName: 'Emër "Pseudonim"',
    });
    if (!result.ok) throw new Error("embed failed");
    const opf = await readEntry(result.bytes, "OEBPS/content.opf");
    expect(opf).toContain("<dc:title>Ujë &amp; Zjarr &lt;2&gt;</dc:title>");
    expect(opf).toContain("<dc:creator>Emër &quot;Pseudonim&quot;</dc:creator>");
    expect(await readEntry(result.bytes, EBOOK_COVER_PAGE_ENTRY)).toContain("<title>Ujë &amp; Zjarr &lt;2&gt;</title>");
  });

  it("a blank or missing title/author keeps the values already in the ebook", async () => {
    const result = await embedCoverInLibrumEpub(await librumEpub(), { coverJpeg: COVER_A, title: "  ", authorName: null });
    if (!result.ok) throw new Error("embed failed");
    const opf = await readEntry(result.bytes, "OEBPS/content.opf");
    expect(opf).toContain("<dc:title>Libri i provës</dc:title>");
    expect(opf).toContain("<dc:creator>Autor Prove</dc:creator>");
  });

  it("2a: refuses a directly uploaded ebook and an unreadable file, changing nothing", async () => {
    expect(await embedCoverInLibrumEpub(await directEpub(""), { coverJpeg: COVER_A })).toEqual({
      ok: false,
      reason: "not_librum_made",
    });
    expect(await embedCoverInLibrumEpub(Buffer.from("garbage"), { coverJpeg: COVER_A })).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("the Read Sample is the same with or without the cover page", async () => {
    const before = await librumEpub();
    const result = await embedCoverInLibrumEpub(before, { coverJpeg: COVER_A });
    if (!result.ok) throw new Error("embed failed");
    const withCover = await extractEpubSample(result.bytes);
    expect(withCover.available).toBe(true);
    expect(withCover).toEqual(await extractEpubSample(before));
    expect(JSON.stringify(withCover)).not.toContain("cover.jpg");
  });
});

describe("embedCoverInLibrumEpub: JPEG only (audit R1)", () => {
  it("refuses a PNG (or any non-JPEG) cover, so no cover.jpg ever holds another format", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVQImWMwTgsFAAG+AO/TH36BAAAAAElFTkSuQmCC", "base64");
    expect(await embedCoverInLibrumEpub(await librumEpub(), { coverJpeg: png })).toEqual({ ok: false, reason: "cover_not_jpeg" });
    expect(await embedCoverInLibrumEpub(await librumEpub(), { coverJpeg: Buffer.alloc(0) })).toEqual({
      ok: false,
      reason: "cover_not_jpeg",
    });
  });
});

describe("readLibrumEbookCover", () => {
  it("is null for a Librum ebook without a cover and for a direct upload", async () => {
    expect(await readLibrumEbookCover(await librumEpub())).toBeNull();
    expect(await readLibrumEbookCover(await directEpub(""))).toBeNull();
  });
});
