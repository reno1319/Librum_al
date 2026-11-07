import { describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  PAGE_ESTIMATE_LABEL,
  WORDS_PER_PAGE,
  pageEstimateFromWords,
  pageEstimateText,
  recordManuscriptWords,
} from "./page-estimate";
import { countEpubWords } from "./epub-sample";

async function epubWith(bodies: string[], { nav = false }: { nav?: boolean } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  );
  const items = bodies.map((_, i) => `<item id="c${i}" href="c${i}.xhtml" media-type="application/xhtml+xml"/>`);
  const refs = bodies.map((_, i) => `<itemref idref="c${i}"/>`);
  if (nav) {
    items.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
    refs.unshift('<itemref idref="nav"/>');
    zip.file("OEBPS/nav.xhtml", "<html><body><nav><ol><li>Kapitulli një dy tre</li></ol></nav></body></html>");
  }
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package version="3.0" xmlns="http://www.idpf.org/2007/opf"><metadata/><manifest>${items.join("")}</manifest><spine>${refs.join("")}</spine></package>`,
  );
  bodies.forEach((body, i) => zip.file(`OEBPS/c${i}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("pageEstimateFromWords / pageEstimateText (Q3 b: exact, minimum 1)", () => {
  it("is words / 250, rounded to the nearest whole page", () => {
    expect(WORDS_PER_PAGE).toBe(250);
    expect(pageEstimateFromWords(45_700)).toBe(183);
    expect(pageEstimateFromWords(45_750)).toBe(183);
    expect(pageEstimateFromWords(45_875)).toBe(184);
    expect(pageEstimateText(45_700)).toBe("rreth 183");
    expect(PAGE_ESTIMATE_LABEL).toBe("Faqe");
    // The row reads "Faqe: rreth 183": the label already says "faqe".
    expect(pageEstimateText(45_700)).not.toMatch(/faqe/i);
  });

  it("never shows less than 1 page", () => {
    expect(pageEstimateFromWords(0)).toBe(1);
    expect(pageEstimateFromWords(100)).toBe(1);
    expect(pageEstimateText(1)).toBe("rreth 1");
  });

  it("shows nothing without a real count (Q4 a)", () => {
    for (const value of [null, undefined, -1, 1.5, Number.NaN, "100", {}]) {
      expect(pageEstimateFromWords(value)).toBeNull();
      expect(pageEstimateText(value)).toBeNull();
    }
  });
});

describe("countEpubWords", () => {
  it("counts the words of every spine document", async () => {
    const bytes = await epubWith(["<p>" + "fjalë ".repeat(300) + "</p>", "<h1>Kapitulli II</h1><p>një dy tre</p>"]);
    expect(await countEpubWords(bytes)).toBe(305);
  });

  it("skips the navigation document, scripts and punctuation-only runs", async () => {
    const bytes = await epubWith(['<p>Ai tha: — Po! … “Mirë”</p><script>var a = 1;</script>'], { nav: true });
    expect(await countEpubWords(bytes)).toBe(4);
  });

  it("counts Albanian letters and digits as words", async () => {
    const bytes = await epubWith(["<p>Çështja ë 1912 ç</p>"]);
    expect(await countEpubWords(bytes)).toBe(4);
  });

  it("is null for a file that is not a readable EPUB", async () => {
    expect(await countEpubWords(Buffer.from("not a zip"))).toBeNull();
    const empty = new JSZip();
    empty.file("mimetype", "application/epub+zip");
    expect(await countEpubWords(Buffer.from(await empty.generateAsync({ type: "nodebuffer" })))).toBeNull();
  });
});

describe("recordManuscriptWords", () => {
  function fakeClient(error: { code?: string } | null = null) {
    const upsert = vi.fn().mockResolvedValue({ error });
    const from = vi.fn().mockReturnValue({ upsert });
    return { client: { from }, from, upsert };
  }

  it("stores the count for that exact book and file", async () => {
    const { client, from, upsert } = fakeClient();
    const bytes = await epubWith(["<p>" + "a ".repeat(500) + "</p>"]);
    await expect(
      recordManuscriptWords(client, { bookId: "b1", filePath: "u/b1/v2.epub", bytes, caller: "test" }),
    ).resolves.toBe("recorded");
    expect(from).toHaveBeenCalledWith("book_file_words");
    expect(upsert).toHaveBeenCalledWith(
      { book_id: "b1", file_path: "u/b1/v2.epub", word_count: 500 },
      { onConflict: "book_id,file_path" },
    );
  });

  it("writes nothing for an unreadable file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, upsert } = fakeClient();
    await expect(
      recordManuscriptWords(client, { bookId: "b1", filePath: "p", bytes: Buffer.from("x"), caller: "test" }),
    ).resolves.toBe("unreadable");
    expect(upsert).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("never throws: a database error or a throwing client is 'failed'", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bytes = await epubWith(["<p>a b</p>"]);
    const { client } = fakeClient({ code: "42P01" });
    await expect(recordManuscriptWords(client, { bookId: "b1", filePath: "p", bytes, caller: "test" })).resolves.toBe("failed");
    const throwing = { from: () => { throw new Error("boom"); } };
    await expect(recordManuscriptWords(throwing, { bookId: "b1", filePath: "p", bytes, caller: "test" })).resolves.toBe("failed");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});
