import { describe, expect, it } from "vitest";
import { readerFrontPageHtml, readerLastPageHtml } from "@/lib/reader-librum-pages";
import { PERSONAL_USE_LINE, type LibrumFrontPage, type LibrumLastPage } from "@/lib/epub-librum-pages";
import { READER_CLASSES, READER_TAGS } from "@/lib/reader-content";

// lbnp2 (Renato 11-24): the online reader shows the download's own pages.
const FRONT: LibrumFrontPage = {
  title: 'Libri "<b>"',
  subtitle: "Një roman & më shumë",
  penName: "Arta Test",
  originalAuthor: null,
  originalTitle: null,
  copyrightYear: 2026,
  originalYear: null,
  translators: [],
  rights: "own_rights",
  librumYear: 2026,
  isbn: "978-9928-123-45-7",
  lbn: "LE7K4M9X2D",
  publisher: "Botime <script>",
  edition: null,
  buyer: { email: "lexues@example.test", date: "24 nëntor 2026", code: "LB-1", free: false },
};
const LAST: LibrumLastPage = {
  penName: "Arta <Test>",
  books: [1, 2, 3, 4, 5, 6].map((n) => ({ title: `Libri ${n} <i>`, url: `https://librum.test/libra/${n}` })),
  reviewUrl: "https://librum.test/libra/x#vleresimet",
};

// Only the reader's own tags and classes (plus the frame's lb-sec/lb-lp).
function expectReaderMarkup(html: string) {
  for (const m of html.matchAll(/<\/?([a-z0-9]+)/g)) {
    expect(m[1] === "section" || READER_TAGS.has(m[1])).toBe(true);
  }
  for (const m of html.matchAll(/<[a-z0-9]+((?:\s[^>]*)?)>/g)) {
    const attrs = m[1].trim();
    if (!attrs) continue;
    expect(attrs).toMatch(/^class="[a-z- ]+"$/);
    for (const c of attrs.slice(7, -1).split(" ")) {
      expect(c === "lb-sec" || c === "lb-lp" || (READER_CLASSES as readonly string[]).includes(c)).toBe(true);
    }
  }
}

describe("reader Librum pages (lbnp2)", () => {
  it("the copyright page: the download's lines in order, LBN under ISBN, buyer line last, on its own page", () => {
    const html = readerFrontPageHtml(FRONT);
    expect(html.startsWith('<section class="lb-sec lb-lp"><h1>Libri &quot;&lt;b&gt;&quot;</h1>')).toBe(true);
    expect(html.endsWith("</section>")).toBe(true);
    expect(html).toContain('<p class="lb-c lb-i">Një roman &amp; më shumë</p>');
    expect(html).toContain('<p class="lb-c">ISBN 978-9928-123-45-7</p>\n<p class="lb-c">LBN: LE7K4M9X2D</p>');
    expect(html).toContain('<p class="lb-c">Botime &lt;script&gt;</p>');
    expect(html).toContain('<p class="lb-gap"></p><p class="lb-c">Botuar në Librum, 2026 · librum.al</p>');
    expect(html).toContain(`<p class="lb-gap"></p><p class="lb-c"><small>${PERSONAL_USE_LINE}</small></p>`);
    expect(html).toMatch(/<small>Blerë nga lexues@example\.test më 24 nëntor 2026 · Kodi i blerjes: LB-1<\/small><\/p><\/section>$/);
    expectReaderMarkup(html);
  });

  it("no buyer, no LBN: those lines are left out, like the download", () => {
    const html = readerFrontPageHtml({ ...FRONT, buyer: null, lbn: null });
    expect(html).not.toContain("Blerë nga");
    expect(html).not.toContain("LBN");
    expectReaderMarkup(html);
  });

  it("a translation keeps its two-line byline (br only)", () => {
    const html = readerFrontPageHtml({ ...FRONT, originalAuthor: "Arthur Machen", translators: ["T. Test"] });
    expect(html).toContain('<p class="lb-c">Arthur Machen<br>');
    expect(html).not.toContain("<br/>");
    expectReaderMarkup(html);
  });

  it("the last page: thanks, up to 5 other books as text, the review line as text; no links", () => {
    const html = readerLastPageHtml(LAST);
    expect(html.startsWith('<section class="lb-sec lb-lp"><h1>Faleminderit që lexuat!</h1><h2>Libra të tjerë nga Arta &lt;Test&gt;</h2>')).toBe(true);
    expect(html).toContain('<p class="lb-c">Libri 5 &lt;i&gt;</p>');
    expect(html).not.toContain("Libri 6");
    expect(html).toContain("<strong>Ju pëlqeu libri? Lini një vlerësim në Librum.</strong>");
    expect(html).not.toContain("<a");
    expect(html).not.toContain("librum.test");
    expectReaderMarkup(html);
    expect(readerLastPageHtml({ ...LAST, books: [] })).not.toContain("<h2>");
  });
});
