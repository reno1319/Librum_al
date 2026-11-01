import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { generateEpub } from "./epub-generator";
import { validateEpubStructure } from "./epub-validation";
import {
  addLibrumPages,
  frontPageBody,
  lastPageBody,
  MAX_MORE_BOOKS,
  PERSONAL_USE_LINE,
  purchaseCode,
  REVIEW_LINE,
  THANKS_LINE,
  frontPageXhtml,
  lastPageXhtml,
  type LibrumFrontPage,
  type LibrumLastPage,
} from "./epub-librum-pages";

// BD3 + BD4 + BD4b. Invented names and example.com emails only.

const FRONT: LibrumFrontPage = {
  title: "Lulja e marsit",
  subtitle: "Tregim",
  penName: "Arben Prova",
  copyrightYear: 2015,
  translators: [],
  librumYear: 2026,
  isbn: null,
  publisher: null,
  edition: null,
  buyer: { email: "ana@example.com", date: "1 nëntor 2026", code: "LB-7Q4K2ABC", free: false },
};

const LAST: LibrumLastPage = {
  penName: "Arben Prova",
  books: [
    { title: "Deti i dimrit", url: "https://librum.al/libra/11111111-1111-4111-8111-111111111111" },
    { title: "Rruga e gjatë", url: "https://librum.al/libra/22222222-2222-4222-8222-222222222222" },
  ],
  reviewUrl: "https://librum.al/libra/33333333-3333-4333-8333-333333333333",
};

const PAGES = { front: FRONT, last: LAST };

const CONTAINER = (path = "OEBPS/content.opf") => `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="${path}" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const [name, body] of Object.entries(files)) zip.file(name, body);
  return zip.generateAsync({ type: "nodebuffer" });
}

async function wordMadeEpub(): Promise<Buffer> {
  return generateEpub({
    bookId: "test-book",
    title: "Lulja e marsit",
    authorName: "Arben Prova",
    sections: [
      { heading: "Kapitulli 1", html: "<p>Mëngjesi ishte i ftohtë.</p>" },
      { heading: "Kapitulli 2", html: "<p>Ajo hapi dritaren.</p>" },
    ],
    images: [],
  });
}

const EPUB2_WITH_COVER = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="uid">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>X</dc:title><dc:identifier id="uid">x</dc:identifier><dc:language>sq</dc:language></metadata>
<manifest>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="coverpage" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine toc="ncx">
<itemref idref="coverpage" linear="no"/>
<itemref idref="c1"/>
</spine>
</package>`;

async function opfOf(bytes: Buffer, path = "OEBPS/content.opf"): Promise<string> {
  return (await JSZip.loadAsync(bytes)).file(path)!.async("string");
}

function spineIds(opf: string): string[] {
  return [...opf.matchAll(/<(?:[a-z0-9]+:)?itemref\b[^>]*idref="([^"]+)"/gi)].map((m) => m[1]);
}

describe("front page wording (approved 1 Nov)", () => {
  it("has the title, subtitle, pen name, © line, Librum line, personal-use line and buyer line in order", () => {
    const html = frontPageBody(FRONT);
    const order = [
      "<h1>Lulja e marsit</h1>",
      "Tregim",
      "Arben Prova",
      "© 2015 Arben Prova. Të gjitha të drejtat e rezervuara.",
      "Botuar në Librum, 2026 · librum.al",
      PERSONAL_USE_LINE,
      "Blerë nga ana@example.com më 1 nëntor 2026 · Kodi i blerjes: LB-7Q4K2ABC",
    ];
    let at = -1;
    for (const part of order) {
      const i = html.indexOf(part);
      expect(i, part).toBeGreaterThan(at);
      at = i;
    }
  });

  it("the author's own copy has no buyer line", () => {
    const html = frontPageBody({ ...FRONT, buyer: null });
    expect(html).not.toContain("Blerë nga");
    expect(html).not.toContain("Kodi i blerjes");
  });

  it("a free book says 'Shkarkuar falas nga' (Renato 1 Nov), not 'Blerë nga'", () => {
    const html = frontPageBody({ ...FRONT, buyer: { ...FRONT.buyer!, free: true } });
    expect(html).toContain("Shkarkuar falas nga ana@example.com më 1 nëntor 2026 · Kodi i blerjes: LB-7Q4K2ABC");
    expect(html).not.toContain("Blerë nga");
  });

  it("a translation adds the translator's © line with the Librum year (4a)", () => {
    const html = frontPageBody({ ...FRONT, translators: ["Drita Shembull", "Gëzim Prova"] });
    expect(html).toContain("Përkthimi © 2026 Drita Shembull, Gëzim Prova.");
  });

  it("ISBN, publisher and edition appear only when filled in", () => {
    expect(frontPageBody(FRONT)).not.toMatch(/ISBN/);
    const html = frontPageBody({ ...FRONT, isbn: "978-0-00-000000-0", publisher: "Shtëpia Prova", edition: "Botimi i dytë" });
    expect(html).toContain("ISBN 978-0-00-000000-0");
    expect(html).toContain("Shtëpia Prova");
    expect(html).toContain("Botimi i dytë");
  });

  it("no subtitle, no subtitle line", () => {
    expect(frontPageBody({ ...FRONT, subtitle: null })).not.toContain('class="sub"');
    expect(frontPageBody({ ...FRONT, subtitle: "   " })).not.toContain('class="sub"');
  });

  it("escapes every detail (a title or email can't break the page)", () => {
    const html = frontPageBody({
      ...FRONT,
      title: `A <b>&"' B`,
      penName: "X & Y",
      buyer: { ...FRONT.buyer!, email: `o'brien+<x>@example.com` },
    });
    expect(html).toContain("<h1>A &lt;b&gt;&amp;&quot;&#39; B</h1>");
    expect(html).toContain("© 2015 X &amp; Y.");
    expect(html).toContain("o&#39;brien+&lt;x&gt;@example.com");
    expect(html).not.toContain("<b>");
  });
});

describe("last page (5a)", () => {
  it("lists the other books with links, then the review link", () => {
    const html = lastPageBody(LAST);
    expect(html).toContain("<h2>Libra të tjerë nga Arben Prova</h2>");
    expect(html).toContain(`<a href="${LAST.books[0].url}">Deti i dimrit</a>`);
    expect(html.indexOf("Rruga e gjatë")).toBeLessThan(html.indexOf(REVIEW_LINE));
    expect(html).toContain(`<a href="${LAST.reviewUrl}"><strong>${REVIEW_LINE}</strong></a>`);
  });

  it("no other book: only the review link, no heading, no empty list", () => {
    const html = lastPageBody({ ...LAST, books: [] });
    expect(html).not.toContain("Libra të tjerë");
    expect(html).not.toContain("<ul>");
    expect(html).toContain(REVIEW_LINE);
  });

  it("opens with the thank-you line, also when there is no other book (patch 2)", () => {
    expect(lastPageBody(LAST).startsWith(`<h1 class="thanks">${THANKS_LINE}</h1>`)).toBe(true);
    expect(lastPageBody({ ...LAST, books: [] }).startsWith(`<h1 class="thanks">${THANKS_LINE}</h1>`)).toBe(true);
    expect(THANKS_LINE).toBe("Faleminderit që lexuat!");
  });

  it("every element says centered and no word-splitting itself (Apple Books test, patch 2)", () => {
    for (const page of [frontPageXhtml(FRONT, false), frontPageXhtml(FRONT, true), lastPageXhtml(LAST, false), lastPageXhtml(LAST, true)]) {
      expect(page).toContain("body,h1,h2,p,ul,li{text-align:center !important;");
      expect(page).toContain("hyphens:none !important");
      expect(page).toContain("adobe-hyphenate:none");
    }
  });

  it("never more than 5 books", () => {
    const books = Array.from({ length: 8 }, (_, i) => ({ title: `Libri ${i}`, url: `https://librum.al/libra/${i}` }));
    const html = lastPageBody({ ...LAST, books });
    expect(html.match(/<li>/g)).toHaveLength(MAX_MORE_BOOKS);
  });
});

describe("purchaseCode", () => {
  it("is LB- plus the first 8 characters of the purchase id, upper case", () => {
    expect(purchaseCode("c0ffee00-1234-4abc-9def-0123456789ab")).toBe("LB-C0FFEE00");
  });
});

describe("addLibrumPages on a Word-made ebook", () => {
  it("adds the front page first and the last page last; every old file is unchanged; still a valid EPUB", async () => {
    const original = await wordMadeEpub();
    const before = await JSZip.loadAsync(original);
    const result = await addLibrumPages(original, PAGES);

    expect(result.added).toBe(true);
    const after = await JSZip.loadAsync(result.bytes);
    for (const name of Object.keys(before.files)) {
      if (name === "OEBPS/content.opf") continue;
      const a = await before.file(name)?.async("uint8array");
      const b = await after.file(name)?.async("uint8array");
      expect(Buffer.from(b ?? []).equals(Buffer.from(a ?? [])), name).toBe(true);
    }
    expect(Object.keys(after.files)[0]).toBe("mimetype");

    const opf = await opfOf(result.bytes);
    expect(spineIds(opf)).toEqual(["librum-front", "chapter1", "chapter2", "librum-end"]);
    expect(opf).toContain('<item id="librum-front" href="librum-faqja-hyrese.xhtml" media-type="application/xhtml+xml"/>');
    expect(opf).toContain('<item id="librum-end" href="librum-faqja-fundit.xhtml" media-type="application/xhtml+xml"/>');

    const front = await after.file("OEBPS/librum-faqja-hyrese.xhtml")!.async("string");
    expect(front).toContain("<!DOCTYPE html>");
    expect(front).toContain("© 2015 Arben Prova.");
    expect(front).toContain("ana@example.com");
    const last = await after.file("OEBPS/librum-faqja-fundit.xhtml")!.async("string");
    expect(last).toContain("Deti i dimrit");

    expect((await validateEpubStructure(result.bytes)).valid).toBe(true);
  });

  it("the stored bytes object itself is never changed", async () => {
    const original = await wordMadeEpub();
    const copy = Buffer.from(original);
    await addLibrumPages(original, PAGES);
    expect(original.equals(copy)).toBe(true);
  });
});

describe("addLibrumPages on uploaded EPUBs", () => {
  it("EPUB 2 with a cover page first: the front page goes right after the cover, XHTML 1.1 doctype", async () => {
    const bytes = await zipOf({
      "META-INF/container.xml": CONTAINER(),
      "OEBPS/content.opf": EPUB2_WITH_COVER,
      "OEBPS/Text/cover.xhtml": "<html/>",
      "OEBPS/Text/c1.xhtml": "<html/>",
    });
    const result = await addLibrumPages(bytes, PAGES);
    expect(result.added).toBe(true);
    const opf = await opfOf(result.bytes);
    expect(spineIds(opf)).toEqual(["coverpage", "librum-front", "c1", "librum-end"]);
    const front = await (await JSZip.loadAsync(result.bytes)).file("OEBPS/librum-faqja-hyrese.xhtml")!.async("string");
    expect(front).toContain("-//W3C//DTD XHTML 1.1//EN");
    expect(front).not.toContain(' lang="sq"');
  });

  it("a cover found by the manifest item's properties also counts", async () => {
    const opf = EPUB2_WITH_COVER.replace('version="2.0"', 'version="3.0"')
      .replace('id="coverpage" href="Text/cover.xhtml"', 'id="p0" href="Text/a.xhtml" properties="svg cover-image"')
      .replace('idref="coverpage"', 'idref="p0"');
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": opf });
    const result = await addLibrumPages(bytes, PAGES);
    expect(spineIds(await opfOf(result.bytes))).toEqual(["p0", "librum-front", "c1", "librum-end"]);
  });

  it("an OPF at the zip root and an opf: prefix are handled", async () => {
    const opf = `<?xml version="1.0"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="u">
<opf:metadata/>
<opf:manifest><opf:item id="a" href="a.xhtml" media-type="application/xhtml+xml"/></opf:manifest>
<opf:spine><opf:itemref idref="a"/></opf:spine>
</opf:package>`;
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER("book.opf"), "book.opf": opf });
    const result = await addLibrumPages(bytes, PAGES);
    expect(result.added).toBe(true);
    const out = await opfOf(result.bytes, "book.opf");
    expect(out).toContain('<opf:item id="librum-front" href="librum-faqja-hyrese.xhtml"');
    expect(spineIds(out)).toEqual(["librum-front", "a", "librum-end"]);
    expect((await JSZip.loadAsync(result.bytes)).file("librum-faqja-hyrese.xhtml")).not.toBeNull();
  });

  it("names and ids already used by the book get a new number", async () => {
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata/>
<manifest><item id="librum-front" href="librum-faqja-hyrese.xhtml" media-type="application/xhtml+xml"/></manifest>
<spine><itemref idref="librum-front"/></spine>
</package>`;
    const bytes = await zipOf({
      "META-INF/container.xml": CONTAINER(),
      "OEBPS/content.opf": opf,
      "OEBPS/librum-faqja-hyrese.xhtml": "author's own file",
    });
    const result = await addLibrumPages(bytes, PAGES);
    const zip = await JSZip.loadAsync(result.bytes);
    expect(await zip.file("OEBPS/librum-faqja-hyrese.xhtml")!.async("string")).toBe("author's own file");
    expect(zip.file("OEBPS/librum-faqja-hyrese-2.xhtml")).not.toBeNull();
    expect(spineIds(await opfOf(result.bytes))).toEqual(["librum-front-2", "librum-front", "librum-end"]);
  });

  it.each([
    ["no container", { "OEBPS/content.opf": EPUB2_WITH_COVER }],
    ["container points nowhere", { "META-INF/container.xml": CONTAINER("missing.opf") }],
    ["no spine end", { "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": EPUB2_WITH_COVER.replace("</spine>", "") }],
    ["self-closing spine", { "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": EPUB2_WITH_COVER.replace(/<spine[\s\S]*<\/spine>/, '<spine toc="ncx"/>') }],
    ["no version", { "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": EPUB2_WITH_COVER.replace(' version="2.0"', "") }],
    [
      "fixed layout",
      {
        "META-INF/container.xml": CONTAINER(),
        "OEBPS/content.opf": EPUB2_WITH_COVER.replace("<dc:title>", '<meta property="rendition:layout">pre-paginated</meta><dc:title>'),
      },
    ],
  ])("%s: served as stored (unsupported_structure)", async (_label, files) => {
    const bytes = await zipOf(files as Record<string, string>);
    const result = await addLibrumPages(bytes, PAGES);
    expect(result).toEqual({ added: false, bytes, failureStage: "unsupported_structure" });
  });

  // Audit r1 (MEDIUM): markup inside a comment must never receive the pages.
  it.each([
    ["a comment holding </manifest> before the real one", (o: string) => o.replace("<manifest>", "<manifest><!-- old </manifest> -->")],
    ["a comment holding <spine> before the real one", (o: string) => o.replace("<manifest>", "<!-- <spine><itemref idref=\"x\"/></spine> --><manifest>")],
    ["a comment holding </spine> inside the spine", (o: string) => o.replace('<itemref idref="c1"/>', '<!-- </spine> --><itemref idref="c1"/>')],
    ["a CDATA block holding </manifest>", (o: string) => o.replace("<manifest>", "<manifest><![CDATA[ </manifest> ]]>")],
  ])("%s: the pages land in the real manifest and spine", async (_label, edit) => {
    const opf = edit(EPUB2_WITH_COVER);
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": opf });
    const result = await addLibrumPages(bytes, PAGES);
    expect(result.added).toBe(true);
    const out = (await opfOf(result.bytes)).replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "");
    expect(spineIds(out)).toEqual(["coverpage", "librum-front", "c1", "librum-end"]);
    const manifest = out.match(/<manifest>([\s\S]*)<\/manifest>/)![1];
    expect(manifest).toContain('id="librum-front"');
    expect(manifest).toContain('id="librum-end"');
  });

  it.each([
    ["an unclosed comment", (o: string) => o.replace("<manifest>", "<manifest><!-- never closed")],
    ["two spines", (o: string) => o.replace("</package>", '<spine><itemref idref="c1"/></spine></package>')],
    ["two manifests", (o: string) => o.replace("<spine", '<manifest></manifest><spine')],
    ["an idref already pointing at librum-front with no item", (o: string) => o.replace('<itemref idref="c1"/>', '<itemref idref="c1"/><itemref idref="librum-front"/>')],
  ])("%s: served as stored", async (_label, edit) => {
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": edit(EPUB2_WITH_COVER) });
    const result = await addLibrumPages(bytes, PAGES);
    expect(result).toEqual({ added: false, bytes, failureStage: "unsupported_structure" });
  });

  // Audit r1 (LOW): "cover" as a whole word only.
  it.each([
    ["discovery", "Text/discovery.xhtml", "p0", false],
    ["recover", "Text/recover.xhtml", "p0", false],
    ["uncover", "Text/uncover.xhtml", "p0", false],
    ["cover.xhtml", "Text/cover.xhtml", "p0", true],
    ["Cover_1.xhtml", "Text/Cover_1.xhtml", "p0", true],
    ["kopertina.xhtml", "Text/kopertina.xhtml", "p0", true],
    ["id coverpage", "Text/a.xhtml", "coverpage", true],
    ["id discoverypage", "Text/a.xhtml", "discoverypage", false],
    ["coverImage.xhtml", "Text/coverImage.xhtml", "p0", true],
    ["bookcover.xhtml", "Text/bookcover.xhtml", "p0", true],
    ["frontcover.xhtml", "Text/frontcover.xhtml", "p0", true],
    ["titlepage.xhtml (no guide)", "Text/titlepage.xhtml", "p0", false],
  ])("first page %s: after it = %s", async (_label, href, id, isCover) => {
    const opf = EPUB2_WITH_COVER.replace('id="coverpage" href="Text/cover.xhtml"', `id="${id}" href="${href}"`).replace('idref="coverpage"', `idref="${id}"`);
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": opf });
    const ids = spineIds(await opfOf((await addLibrumPages(bytes, PAGES)).bytes));
    expect(ids).toEqual(isCover ? [id, "librum-front", "c1", "librum-end"] : ["librum-front", id, "c1", "librum-end"]);
  });

  // Audit r2 (N2): Calibre's titlepage.xhtml marked as the cover in the guide.
  it("Calibre: titlepage.xhtml named by <guide><reference type=\"cover\"> counts as the cover", async () => {
    const opf = EPUB2_WITH_COVER.replace('id="coverpage" href="Text/cover.xhtml"', 'id="titlepage" href="titlepage.xhtml"')
      .replace('idref="coverpage"', 'idref="titlepage"')
      .replace("</package>", '<guide><reference type="cover" title="Cover" href="titlepage.xhtml"/></guide></package>');
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": opf });
    expect(spineIds(await opfOf((await addLibrumPages(bytes, PAGES)).bytes))).toEqual(["titlepage", "librum-front", "c1", "librum-end"]);
  });

  it("a guide cover that is not the first page changes nothing", async () => {
    const opf = EPUB2_WITH_COVER.replace('id="coverpage" href="Text/cover.xhtml"', 'id="p0" href="Text/a.xhtml"')
      .replace('idref="coverpage"', 'idref="p0"')
      .replace("</package>", '<guide><reference type="cover" href="Text/c1.xhtml"/></guide></package>');
    const bytes = await zipOf({ "META-INF/container.xml": CONTAINER(), "OEBPS/content.opf": opf });
    expect(spineIds(await opfOf((await addLibrumPages(bytes, PAGES)).bytes))).toEqual(["librum-front", "p0", "c1", "librum-end"]);
  });

  it("not a zip at all: unexpected_exception, the same bytes back", async () => {
    const bytes = Buffer.from("not a zip");
    const result = await addLibrumPages(bytes, PAGES);
    expect(result).toEqual({ added: false, bytes, failureStage: "unexpected_exception" });
  });
});
