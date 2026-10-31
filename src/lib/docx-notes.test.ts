import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import { convertDocxToDocument, type DocSection } from "./docx-converter";
import { generateEpub } from "./epub-generator";
import { ENDNOTES_HEADING, extractNotes, renderNotes } from "./docx-notes";
import { parseChapterXhtml, textOf } from "./ebook-preview-html";
import { buildDocxBytes, emptyPara, fmt, heading, note, noteRef, paragraph, prose, textWithNotes } from "./docx-test-fixtures";

// W3 Part 2: Word footnotes and endnotes kept in the ebook (Renato 31
// Oct: 8a book-order numbers, 1b footnotes at the end of their chapter
// and endnotes in a "Shënime" chapter, 2a only with the clean-up pass
// on, 3a a note number on a chapter title stays on the title only).
// All text is invented.

afterEach(() => {
  vi.unstubAllEnvs();
});

async function convert(options: Parameters<typeof buildDocxBytes>[0], preview = false) {
  const result = await convertDocxToDocument(await buildDocxBytes({ includeStyles: true, ...options }), {}, { preview });
  if (!result.success) throw new Error(`conversion failed: ${result.error}`);
  return result;
}

function headingWithNote(text: string, ref: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${text}</w:t></w:r>${ref}</w:p>`;
}

// Every internal link of the ebook points at a file and an id that exist,
// no id appears twice in a file and no link sits inside another link
// (audit F1, F2: both make the ebook invalid).
async function brokenLinks(sections: DocSection[]): Promise<string[]> {
  const epub = await generateEpub({ bookId: "00000000-0000-4000-8000-000000000001", title: "Libri", authorName: "Autori", sections, images: [] });
  const zip = await JSZip.loadAsync(epub);
  const ids = new Map<string, Set<string>>();
  const pages: [string, string][] = [];
  const broken: string[] = [];
  for (const name of Object.keys(zip.files).filter((n) => /^OEBPS\/chapter-\d+\.xhtml$/.test(n))) {
    const xhtml = await zip.file(name)!.async("string");
    const file = name.slice("OEBPS/".length);
    const all = [...xhtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    ids.set(file, new Set(all));
    pages.push([file, xhtml]);
    for (const id of new Set(all.filter((id, i) => all.indexOf(id) !== i))) broken.push(`${file}: id "${id}" twice`);
    let depth = 0;
    for (const m of xhtml.matchAll(/<a\b[^>]*>|<\/a>/g)) {
      if (m[0] === "</a>") depth--;
      else if (++depth > 1) broken.push(`${file}: link inside a link`);
    }
  }
  for (const [file, xhtml] of pages) {
    for (const m of xhtml.matchAll(/\bhref="([^"]+)"/g)) {
      const href = m[1];
      if (/^(?:https?:|mailto:)/.test(href) || href === "styles.css") continue;
      const [target, frag] = href.startsWith("#") ? [file, href.slice(1)] : href.split("#");
      if (!ids.has(target) || (frag && !ids.get(target)!.has(frag))) broken.push(`${file} -> ${href}`);
    }
  }
  return broken;
}

describe("footnotes (W3 Part 2)", () => {
  it("keeps footnotes at the end of their own chapter, numbered in book order, with links both ways", async () => {
    const r = await convert({
      bodyXml:
        heading(1, "Kapitulli 1") +
        textWithNotes("Fshati ishte në jug", noteRef("footnote", 40), " të vendit.") +
        heading(1, "Kapitulli 2") +
        paragraph("Asnjë shënim këtu.") +
        heading(1, "Kapitulli 3") +
        textWithNotes("Kur u kthye", noteRef("footnote", 7), ", gjithçka kishte ndryshuar", noteRef("footnote", 12), "."),
      footnotesXml:
        note("footnote", 40, paragraph(" Emri i fshatit është i trilluar.")) +
        note("footnote", 7, paragraph("Shih kapitullin e parë.")) +
        note("footnote", 12, paragraph("Para vitit 1912 & pas tij.")),
    });
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2", "Kapitulli 3"]);
    const [one, two, three] = r.sections.map((s) => s.html);
    // Word's own ids (40, 7, 12) never show; numbers follow the book.
    expect(one).toContain('<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup>');
    expect(one).toContain('<aside epub:type="footnote" id="fn-1" class="footnote"><p><a href="#fnref-1">1</a> Emri i fshatit është i trilluar.</p></aside>');
    expect(two).not.toContain("aside");
    expect(three).toContain('href="#fn-2"');
    expect(three).toContain('href="#fn-3"');
    expect(three).toContain("Para vitit 1912 &amp; pas tij.");
    expect(three.indexOf('id="fn-2"')).toBeLessThan(three.indexOf('id="fn-3"'));
    for (const html of [one, three]) {
      expect(html).not.toMatch(/\[\d+\]|footnote-ref-|#footnote-|↑|[]/);
    }
    expect(r.cleanup.notes).toEqual({ footnotes: 3, endnotes: 0, dropped: 0 });
    expect(r.warnings.some((w) => w.code === "footnotes_or_endnotes_skipped")).toBe(false);
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("folds the doubled superscript Apple Pages writes around a note number into one", async () => {
    const r = await convert({
      bodyXml: heading(1, "Kreu") + textWithNotes("Fjala", noteRef("footnote", 3, true), " vazhdon."),
      footnotesXml: note("footnote", 3, paragraph("Shënimi.")),
    });
    expect(r.sections[0].html).toContain('Fjala<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup> vazhdon.');
    expect(r.sections[0].html).not.toContain("<sup><sup>");
  });

  it("keeps a note of two paragraphs with italics, and a note holding a list", async () => {
    const r = await convert({
      bodyXml: heading(1, "Kreu") + textWithNotes("Një", noteRef("footnote", 2), " dhe dy", noteRef("footnote", 3), "."),
      includeNumbering: true,
      footnotesXml:
        note("footnote", 2, fmt("Paragrafi i parë i shënimit, me ", {}) + fmt("fjalë të pjerrëta", { italic: true }) + paragraph("Paragrafi i dytë.")) +
        note("footnote", 3, paragraph("Lista:") + `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>e para</w:t></w:r></w:p>`),
    });
    const html = r.sections[0].html;
    const first = html.slice(html.indexOf('id="fn-1"'), html.indexOf('id="fn-2"'));
    expect(first).toContain("<em>fjalë të pjerrëta</em>");
    expect(first).toContain("<p>Paragrafi i dytë.</p>");
    const second = html.slice(html.indexOf('id="fn-2"'));
    expect(second).toContain("<li>e para</li>");
    expect(second).toContain("</ul></aside>");
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("keeps a note number on a chapter title on the title, never in the contents list (answer 3a)", async () => {
    const r = await convert({
      bodyXml: headingWithNote("PARATHËNIE", noteRef("footnote", 5, true)) + prose("Dita") + heading(1, "Tregimi") + prose("Nata"),
      footnotesXml: note("footnote", 5, paragraph("Shënimi i titullit.")),
    });
    expect(r.sections[0].heading).toBe("PARATHËNIE");
    expect(r.sections[0].headingNotes).toBe('<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup>');
    expect(r.sections[0].html).toContain('<aside epub:type="footnote" id="fn-1" class="footnote"><p><a href="#fnref-1">1</a> Shënimi i titullit.</p></aside>');
    const epub = await JSZip.loadAsync(await generateEpub({ bookId: "00000000-0000-4000-8000-000000000001", title: "L", authorName: "A", sections: r.sections, images: [] }));
    const page = await epub.file("OEBPS/chapter-1.xhtml")!.async("string");
    expect(page).toContain('<h1>PARATHËNIE<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup></h1>');
    const nav = await epub.file("OEBPS/nav.xhtml")!.async("string");
    expect(nav).toContain(">PARATHËNIE</a>");
    expect(nav).not.toContain("fn-1");
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("puts endnotes in one 'Shënime' chapter at the end, linked both ways across chapters (answer 1b)", async () => {
    const r = await convert({
      bodyXml:
        heading(1, "Kreu i parë") +
        textWithNotes("Fillimi", noteRef("endnote", 2), " dhe një shënim poshtë faqes", noteRef("footnote", 9), ".") +
        heading(1, "Kreu i dytë") +
        textWithNotes("Mbarimi", noteRef("endnote", 4), "."),
      footnotesXml: note("footnote", 9, paragraph("Poshtë faqes.")),
      endnotesXml: note("endnote", 2, paragraph("Shënim në fund, i pari.")) + note("endnote", 4, paragraph("Shënim në fund, i dyti.")),
    });
    expect(r.sections.map((s) => s.heading)).toEqual(["Kreu i parë", "Kreu i dytë", ENDNOTES_HEADING]);
    expect(r.sections[0].html).toContain('<a epub:type="noteref" href="chapter-3.xhtml#en-1" id="enref-1">1</a>');
    expect(r.sections[0].html).toContain('<a epub:type="noteref" href="#fn-1" id="fnref-1">1</a>');
    expect(r.sections[1].html).toContain('href="chapter-3.xhtml#en-2" id="enref-2"');
    const notes = r.sections[2].html;
    expect(notes).toContain('<div class="endnote" id="en-1"><p><a href="chapter-1.xhtml#enref-1">1</a> Shënim në fund, i pari.</p></div>');
    expect(notes).toContain('<div class="endnote" id="en-2"><p><a href="chapter-2.xhtml#enref-2">2</a> Shënim në fund, i dyti.</p></div>');
    expect(notes).not.toContain("Poshtë faqes.");
    expect(r.cleanup.notes).toEqual({ footnotes: 1, endnotes: 2, dropped: 0 });
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("gives the preview the same notes and the same 'Shënime' chapter, and the preview reader keeps them", async () => {
    const options = {
      bodyXml: heading(1, "Kreu") + textWithNotes("Teksti", noteRef("footnote", 2), " dhe", noteRef("endnote", 3), "."),
      footnotesXml: note("footnote", 2, paragraph("Poshtë.")),
      endnotesXml: note("endnote", 3, paragraph("Në fund.")),
    };
    const r = await convert(options, true);
    const plain = await convert(options, false);
    const { preview, ...rest } = r;
    expect(rest).toEqual(plain);
    expect(preview!.map((p) => p.heading)).toEqual(["Kreu", ENDNOTES_HEADING]);
    expect(preview![0].html.replace(/<span data-[ps]="\d+"><\/span>/g, "")).toBe(r.sections[0].html);
    const nodes = parseChapterXhtml(`<body>${r.sections[0].html}</body>`);
    const aside = nodes.find((n) => typeof n !== "string" && n.tag === "aside");
    expect(aside && typeof aside !== "string" && aside.attrs.class).toBe("footnote");
    expect(textOf(aside!)).toBe("1 Poshtë.");
    const div = parseChapterXhtml(`<body>${r.sections[1].html}</body>`)[0];
    expect(typeof div !== "string" && div.tag === "div" && div.attrs.class).toBe("endnote");
    // Any other class on these tags is dropped.
    const other = parseChapterXhtml('<body><aside class="x"><p>a</p></aside><div class="footnote">b</div></body>');
    expect(other.map((n) => (typeof n === "string" ? n : n.attrs.class ?? null))).toEqual([null, null]);
  });

  it("can't be faked: private-use characters in the author's text never become note links", async () => {
    const r = await convert({ bodyXml: heading(1, "Kreu") + paragraph("Teksti f2 këtu."), footnotesXml: note("footnote", 2, paragraph("Shënimi.")) });
    expect(r.sections[0].html).not.toContain("noteref");
    expect(r.sections[0].html).not.toContain("aside");
    expect(r.sections[0].html).toContain("Teksti f2 këtu.");
  });

  it("keeps removing notes, with the warning, on Production (answer 2a: one switch)", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const r = await convert({
      bodyXml: heading(1, "Kreu") + textWithNotes("Teksti", noteRef("footnote", 2), " dhe", noteRef("endnote", 3), "."),
      footnotesXml: note("footnote", 2, paragraph("Poshtë.")),
      endnotesXml: note("endnote", 3, paragraph("Në fund.")),
    });
    expect(r.sections.map((s) => s.heading)).toEqual(["Kreu"]);
    expect(r.sections[0].html).not.toMatch(/aside|noteref|Poshtë|Në fund/);
    expect(r.cleanup.notes).toEqual({ footnotes: 0, endnotes: 0, dropped: 0 });
    expect(r.warnings.some((w) => w.code === "footnotes_or_endnotes_skipped")).toBe(true);
  });

  it("counts a note whose number is gone from the text as dropped, and never links to it", () => {
    const { html, bodies } = extractNotes(
      '<p>A<sup><a href="#footnote-2" id="footnote-ref-2">[1]</a></sup></p><ol><li id="footnote-2"><p> Kept. <a href="#footnote-ref-2">↑</a></p></li><li id="footnote-5"><p> Lost. <a href="#footnote-ref-5">↑</a></p></li></ol>',
    );
    expect(html).toBe("<p>A<sup>f2</sup></p><ol></ol>");
    const r = renderNotes([{ html, headingKeys: [] }], bodies, (h) => h, (i) => `chapter-${i + 1}.xhtml`);
    expect(r.footnotes).toBe(1);
    expect(r.unplaced).toBe(1);
    expect(r.sections[0].html).not.toContain("Lost.");
    // A reference whose note text is missing leaves nothing behind.
    const lone = renderNotes([{ html: "<p>B<sup>f9</sup></p>", headingKeys: [] }], new Map(), (h) => h, (i) => `c${i}`);
    expect(lone.sections[0].html).toBe("<p>B</p>");
  });

  it("keeps a footnote inside a table cell", async () => {
    const r = await convert({
      bodyXml: heading(1, "Kreu") + `<w:tbl><w:tr><w:tc>${textWithNotes("Qeliza", noteRef("footnote", 2))}</w:tc></w:tr></w:tbl>` + emptyPara() + prose("Dita"),
      footnotesXml: note("footnote", 2, paragraph("Shënim në tabelë.")),
    });
    expect(r.sections[0].html).toContain('Qeliza<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup>');
    expect(r.sections[0].html).toContain("Shënim në tabelë.");
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  // Audit F1 (31 Oct): a note the text points at twice.
  it.each(["footnote", "endnote"] as const)("gives a %s referenced twice one id, with both numbers linking to it", async (kind) => {
    const r = await convert({
      bodyXml: heading(1, "Kapitulli 1") + textWithNotes("Një", noteRef(kind, 5), " dy", noteRef(kind, 5), " tre.") + prose("Pastaj."),
      [kind === "footnote" ? "footnotesXml" : "endnotesXml"]: note(kind, 5, paragraph("Shënimi.")),
    });
    const html = r.sections[0].html;
    const short = kind === "footnote" ? "fn" : "en";
    expect(html.match(new RegExp(`id="${short}ref-1"`, "g"))).toHaveLength(1);
    expect(html.match(new RegExp(`href="[^"]*#${short}-1"`, "g"))).toHaveLength(2);
    const notes = kind === "footnote" ? html : r.sections[1].html;
    expect(notes.match(/Shënimi\./g)).toHaveLength(1);
    expect(r.cleanup.notes).toEqual({ footnotes: kind === "footnote" ? 1 : 0, endnotes: kind === "endnote" ? 1 : 0, dropped: 0 });
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("gives the id to the title's number when the title and the text point at the same note", async () => {
    const r = await convert({
      bodyXml: headingWithNote("Kapitulli 1", noteRef("footnote", 3)) + textWithNotes("Tekst", noteRef("footnote", 3), "."),
      footnotesXml: note("footnote", 3, paragraph("Një shënim.")),
    });
    expect(r.sections[0].headingNotes).toContain('id="fnref-1"');
    expect(r.sections[0].html).toContain('<sup><a epub:type="noteref" href="#fn-1">1</a></sup>');
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  // Audit F2 (31 Oct): a note number inside a web link (a pasted citation).
  it.each(["footnote", "endnote"] as const)("moves a %s number inside a web link to just after the link", async (kind) => {
    const r = await convert({
      bodyXml:
        heading(1, "Kapitulli 1") +
        `<w:p><w:hyperlink r:id="rIdL"><w:r><w:t>faqja</w:t></w:r>${noteRef(kind, 3)}<w:r><w:t xml:space="preserve"> e burimit</w:t></w:r></w:hyperlink><w:r><w:t xml:space="preserve"> vazhdon.</w:t></w:r></w:p>` +
        prose("Pastaj."),
      [kind === "footnote" ? "footnotesXml" : "endnotesXml"]: note(kind, 3, paragraph("Burimi.")),
      includeHyperlinkRel: [{ id: "rIdL", target: "https://example.com/" }],
    });
    const short = kind === "footnote" ? "fn" : "en";
    const html = r.sections[0].html;
    expect(html).toMatch(new RegExp(`<a href="https://example.com/"[^>]*>faqja e burimit</a><sup><a epub:type="noteref" href="[^"]*#${short}-1" id="${short}ref-1">1</a></sup> vazhdon\\.`));
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("moves several note numbers in one link after it, in order, and leaves the author's own superscript where it was", () => {
    const bodies = new Map([["f1", "<p>A</p>"], ["f2", "<p>B</p>"]]);
    const r = renderNotes(
      [{ html: '<p><a href="https://example.com/">x<sup>\uE002f1\uE003</sup> y<sup>2a \uE002f2\uE003</sup></a> z</p>', headingKeys: [] }],
      bodies,
      (h) => h,
      (i) => `chapter-${i + 1}.xhtml`,
    );
    expect(r.sections[0].html).toMatch(
      /^<p><a href="https:\/\/example.com\/">x y<sup>2a <\/sup><\/a><sup><a [^>]*href="#fn-1"[^>]*>1<\/a><\/sup><sup><a [^>]*href="#fn-2"[^>]*>2<\/a><\/sup> z<\/p>/,
    );
  });

  // Audit F3 (31 Oct): a note Librum can't read never vanishes silently.
  it("still warns when Word has a note that did not come through as a note", async () => {
    const r = await convert({
      bodyXml: heading(1, "Kapitulli 1") + textWithNotes("Një", noteRef("footnote", 12345678901234), " dy.") + prose("Tre."),
      footnotesXml: note("footnote", 12345678901234, paragraph("Shënimi i humbur.")),
    });
    expect(r.warnings.map((w) => w.code)).toContain("footnotes_or_endnotes_skipped");
    expect(r.sections[0].html).not.toMatch(/\[\d+\]|#footnote-|[\uE002\uE003]/);
    // A ten-digit Word id is read as a normal note.
    const ten = await convert({
      bodyXml: heading(1, "Kapitulli 1") + textWithNotes("Një", noteRef("footnote", 1234567890), " dy.") + prose("Tre."),
      footnotesXml: note("footnote", 1234567890, paragraph("Shënimi.")),
    });
    expect(ten.warnings.map((w) => w.code)).not.toContain("footnotes_or_endnotes_skipped");
    expect(ten.cleanup.notes.footnotes).toBe(1);
  });

  it("does not warn when every note came through", async () => {
    const r = await convert({
      bodyXml: heading(1, "Kapitulli 1") + textWithNotes("Një", noteRef("footnote", 2), noteRef("endnote", 2), "."),
      footnotesXml: note("footnote", 2, paragraph("F.")),
      endnotesXml: note("endnote", 2, paragraph("E.")),
    });
    expect(r.warnings).toEqual([]);
  });

  // Audit r2 F1b (31 Oct): each chapter is its own file, so a second
  // reference in another chapter must name the note's file.
  it("links a footnote referenced again in a later chapter to the note's own chapter file", async () => {
    const r = await convert({
      bodyXml:
        heading(1, "Kapitulli 1") +
        textWithNotes("Një", noteRef("footnote", 5), ".") +
        heading(1, "Kapitulli 2") +
        textWithNotes("Dy", noteRef("footnote", 5), " dhe", noteRef("footnote", 6), "."),
      footnotesXml: note("footnote", 5, paragraph("Shënimi.")) + note("footnote", 6, paragraph("I dyti.")),
    });
    const [one, two] = r.sections.map((s) => s.html);
    expect(one).toContain('<sup><a epub:type="noteref" href="#fn-1" id="fnref-1">1</a></sup>');
    expect(two).toContain('<sup><a epub:type="noteref" href="chapter-1.xhtml#fn-1">1</a></sup>');
    // A note first used in chapter 2 stays a same-file link there.
    expect(two).toContain('<sup><a epub:type="noteref" href="#fn-2" id="fnref-2">2</a></sup>');
    expect(one.match(/<aside/g)).toHaveLength(1);
    expect(two.match(/<aside/g)).toHaveLength(1);
    expect(await brokenLinks(r.sections)).toEqual([]);
  });

  it("links every repeat right: a footnote on chapter 1's title used again in chapter 2's title and text, and an endnote in three places", async () => {
    const r = await convert({
      bodyXml:
        headingWithNote("Kapitulli 1", noteRef("footnote", 3) + noteRef("endnote", 4)) +
        textWithNotes("Një", noteRef("endnote", 4), ".") +
        headingWithNote("Kapitulli 2", noteRef("footnote", 3)) +
        textWithNotes("Dy", noteRef("footnote", 3), noteRef("endnote", 4), "."),
      footnotesXml: note("footnote", 3, paragraph("Titulli.")),
      endnotesXml: note("endnote", 4, paragraph("Fundi.")),
    });
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2", "Shënime"]);
    expect(r.sections[0].headingNotes).toContain('href="#fn-1" id="fnref-1"');
    expect(r.sections[1].headingNotes).toContain('href="chapter-1.xhtml#fn-1">');
    expect(r.sections[1].html).toContain('href="chapter-1.xhtml#fn-1">');
    expect(r.sections[2].html).toContain('<a href="chapter-1.xhtml#enref-1">1</a>');
    expect(await brokenLinks(r.sections)).toEqual([]);
    // The preview copy gets the same links.
    const p = await convert(
      {
        bodyXml: heading(1, "Kapitulli 1") + textWithNotes("Një", noteRef("footnote", 5), ".") + heading(1, "Kapitulli 2") + textWithNotes("Dy", noteRef("footnote", 5), "."),
        footnotesXml: note("footnote", 5, paragraph("Shënimi.")),
      },
      true,
    );
    expect(p.preview![1].html).toContain('href="chapter-1.xhtml#fn-1"');
  });

  // Audit r2 F5 (31 Oct): a note deleted with Track Changes is not lost.
  it.each([
    ["deleted", (ref: string) => `<w:del w:id="91" w:author="A">${ref}</w:del>`, 0],
    ["moved away", (ref: string) => `<w:moveFrom w:id="92" w:author="A">${ref}</w:moveFrom>`, 0],
    ["inserted", (ref: string) => `<w:ins w:id="93" w:author="A">${ref}</w:ins>`, 1],
  ] as const)("gives no 'notes left out' warning for a note reference %s with Track Changes", async (_name, wrap, kept) => {
    const r = await convert({
      bodyXml:
        heading(1, "Kapitulli 1") +
        `<w:p><w:pPr><w:rPr><w:del w:id="90" w:author="A"/></w:rPr></w:pPr><w:r><w:t>Një</w:t></w:r>${wrap(noteRef("footnote", 4))}<w:r><w:t xml:space="preserve"> dy.</w:t></w:r></w:p>` +
        prose("Tre."),
      footnotesXml: note("footnote", 4, paragraph("Shënimi.")),
    });
    expect(r.warnings.map((w) => w.code)).not.toContain("footnotes_or_endnotes_skipped");
    expect(r.cleanup.notes.footnotes).toBe(kept);
    expect(await brokenLinks(r.sections)).toEqual([]);
  });
});
