import { describe, expect, it } from "vitest";
import { convertDocxToDocument } from "./docx-converter";
import { buildDocxBytes, emptyPara, fmt, heading, paragraph, prose } from "./docx-test-fixtures";

// W4: the author preview. All text is invented.

async function both(bodyXml: string, options = {}) {
  const bytes = await buildDocxBytes({ bodyXml });
  const plain = await convertDocxToDocument(bytes, options);
  const marked = await convertDocxToDocument(bytes, options, { preview: true });
  if (!plain.success || !marked.success) throw new Error("conversion failed");
  return { plain, marked };
}

const title = (text: string, first = false) => fmt(text, { align: "center", size: 36, pageBreakBefore: !first });

describe("W4 preview marks", () => {
  it("gives the ebook exactly the same chapters with or without the preview", async () => {
    const { plain, marked } = await both(
      title("Liqeni", true) + emptyPara() + prose("Dita") + prose("Nata") + emptyPara(2) + prose("Era") + prose("Shiu") +
      title("Kodra") + prose("Mëngjesi") + emptyPara() + prose("Mbrëmja") + prose("Drita"),
    );
    expect(marked.sections).toEqual(plain.sections);
    expect(plain.preview).toBeUndefined();
    expect(marked.preview).toHaveLength(plain.sections.length);
    for (const s of marked.sections) expect(s.html).not.toMatch(/lbp_|lbs_|data-p|/);
  });

  it("marks chapter titles, paragraphs and scene breaks with their Word paragraph numbers", async () => {
    const { marked } = await both(
      heading(1, "Liqeni") + prose("Dita") + prose("Nata") + emptyPara(2) + prose("Era") + prose("Shiu") + prose("Bora"),
    );
    const [s] = marked.preview!;
    expect(s.heading).toBe("Liqeni");
    expect(s.headingPara).toBe(0);
    expect(s.html).toMatch(/^<p><span data-p="1"><\/span>/);
    expect(s.html).toContain('<span data-p="2"></span>');
    expect(s.html).toMatch(/<p class="scene-break"><span data-s="5"><\/span>\* \* \*<\/p><p><span data-p="5"><\/span>/);
  });

  it("drops private-use characters typed in the manuscript so they can't fake a mark", async () => {
    const { marked, plain } = await both(heading(1, "Titulli") + paragraph("Tekst p9 këtu."));
    expect(marked.preview![0].html).not.toContain('data-p="9"');
    expect(plain.sections[0].html).toContain("Tekst");
  });
});

describe("W4 author choices in the clean-up pass", () => {
  async function convert(bodyXml: string, options = {}) {
    const r = await convertDocxToDocument(await buildDocxBytes({ bodyXml, includeStyles: true }), options);
    if (!r.success) throw new Error("conversion failed");
    return r;
  }
  // Heading 0, Dita 1, Nata 2, empty 3, Era 4, Shiu 5, Bora 6, empty 7, 8, Hëna 9, Dielli 10, Yjet 11
  const book =
    heading(1, "Liqeni") + prose("Dita") + prose("Nata") + emptyPara() + prose("Era") + prose("Shiu") + prose("Bora") +
    emptyPara(2) + prose("Hëna") + prose("Dielli") + prose("Yjet");
  const breaks = (html: string) => (html.match(/scene-break/g) ?? []).length;

  it("accepts a single-empty-line suggestion and takes out an automatic break", async () => {
    const base = await convert(book);
    expect(breaks(base.sections[0].html)).toBe(1);
    expect(base.cleanup.guesses.filter((g) => g.kind === "scene_break").map((g) => [g.paragraph, g.applied])).toEqual([[4, false], [9, true]]);

    const added = await convert(book, { sceneBreak: [4] });
    expect(breaks(added.sections[0].html)).toBe(2);
    expect(added.cleanup.guesses.find((g) => g.paragraph === 4)).toMatchObject({ applied: true, confidence: "medium" });

    const removed = await convert(book, { noSceneBreak: [9] });
    expect(breaks(removed.sections[0].html)).toBe(0);
    expect(removed.cleanup.guesses.find((g) => g.paragraph === 9)!.signs).toContain("taken out by the author");
  });

  it("makes any short line a chapter, and undoes a Heading 1 the author says is not a chapter", async () => {
    const r = await convert(heading(1, "Liqeni") + prose("Dita") + paragraph("Pas shiut") + prose("Nata") + heading(1, "Gabim") + prose("Era"));
    expect(r.sections.map((s) => s.heading)).toEqual(["Liqeni", "Gabim"]);
    const made = await convert(heading(1, "Liqeni") + prose("Dita") + paragraph("Pas shiut") + prose("Nata") + heading(1, "Gabim") + prose("Era"), {
      makeChapter: [2],
      notChapter: [4],
    });
    expect(made.sections.map((s) => s.heading)).toEqual(["Liqeni", "Pas shiut"]);
    expect(made.sections[1].html).toContain("<p>Gabim</p>");
  });

  it("turns a sub-heading and a poem back into normal text", async () => {
    const chapter = (t: string, first = false) => title(t, first) + emptyPara();
    const sub = fmt("Mbi gjuhën", { italic: true });
    const body =
      chapter("Liqeni", true) + prose("Dita") + emptyPara() + sub + fmt(`${"Fjali e gjatë e tekstit të zakonshëm. ".repeat(4)}`) + prose("Nata") +
      chapter("Kodra") + prose("Era") + fmt("Hëna e zbehtë") + fmt("mbi kodrën e heshtur") + fmt("era fryn lehtë") + fmt("dhe nata vjen") + prose("Shiu");
    const r = await convert(body);
    const subGuess = r.cleanup.guesses.find((g) => g.kind === "subheading");
    const verseGuess = r.cleanup.guesses.find((g) => g.kind === "verse");
    expect(subGuess).toMatchObject({ applied: true });
    expect(verseGuess).toMatchObject({ applied: true });
    expect(r.sections[0].html).toContain("<h2><em>Mbi gjuhën</em></h2>");
    expect(r.sections[1].html).toContain('class="verse"');

    const back = await convert(body, { notSubheading: [subGuess!.paragraph], notVerse: [verseGuess!.paragraph] });
    expect(back.sections[0].html).not.toContain("<h2>");
    expect(back.sections[1].html).not.toContain('class="verse');
    expect(back.cleanup.guesses.find((g) => g.kind === "subheading")).toMatchObject({ applied: false });
    expect(back.cleanup.guesses.find((g) => g.kind === "verse")).toMatchObject({ applied: false });
  });

  it("keeps the author's quotes when the quotes switch is off", async () => {
    const r = await convert(heading(1, "A") + paragraph('Ai tha "po" dhe iku...'), { fixQuotes: false });
    expect(r.sections[0].html).toContain('"po"');
    expect(r.cleanup.quoteStyle).toBe("off");
  });
});

describe("W4 r2 (audit F1, N1)", () => {
  async function convert(bodyXml: string, options = {}, preview = false) {
    const r = await convertDocxToDocument(await buildDocxBytes({ bodyXml, includeStyles: true }), options, { preview });
    if (!r.success) throw new Error("conversion failed");
    return r;
  }
  const look = { align: "center" as const, bold: true, size: 32 };
  // Kapitulli 1 0, Fillimi 1, empty 2, Dita 3, Nata 4 | Kapitulli 2 5, Kthimi 6, empty 7, Era 8, Shiu 9 | Kapitulli 3 10, Mbarimi 11, ...
  const chapter = (label: string, name: string, first: boolean) =>
    fmt(label, { ...look, pageBreakBefore: !first }) + fmt(name, look) + emptyPara() + prose("Dita") + prose("Nata");
  const book = chapter("Kapitulli 1", "Fillimi", true) + chapter("Kapitulli 2", "Kthimi", false) + chapter("Kapitulli 3", "Mbarimi", false);

  it("takes out a whole 'Kapitulli N' + title chapter, not just its label (p07)", async () => {
    const base = await convert(book, {}, true);
    expect(base.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi", "Kapitulli 2: Kthimi", "Kapitulli 3: Mbarimi"]);
    expect(base.preview![1].headingPara).toBe(5);
    const r = await convert(book, { notChapter: [5] }, true);
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi", "Kapitulli 3: Mbarimi"]);
    expect(r.sections[0].html).toContain("Kapitulli 2");
    expect(r.sections[0].html).toContain("Kthimi");
    expect(r.cleanup.guesses.filter((g) => g.kind === "chapter" && g.applied).map((g) => g.paragraph)).toEqual([0, 10]);
  });

  it("takes out a bare label chapter and the chapter title right after it", async () => {
    const r0 = await convert(heading(1, "Kapitulli 1") + heading(1, "Fillimi i rrugës (1944)") + prose("Dita") + heading(1, "Kapitulli 2") + heading(1, "Kthimi") + prose("Era"));
    expect(r0.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi i rrugës (1944)", "Kapitulli 2: Kthimi"]);
    const r = await convert(heading(1, "Kapitulli 1") + heading(1, "Fillimi i rrugës (1944)") + prose("Dita") + heading(1, "Kapitulli 2") + heading(1, "Kthimi") + prose("Era"), { notChapter: [3] });
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi i rrugës (1944)"]);
  });

  it("ignores the author's own bookmarks named like Librum's marks (N1), and the ebook stays the same", async () => {
    const bm = (name: string, id: number) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`;
    const body =
      heading(1, "Liqeni") + prose("Dita") +
      `<w:p>${bm("lbs_2", 7)}<w:r><w:t>Një rresht me shenjë të autorit.</w:t></w:r></w:p>` + bm("lbp_1", 8) + prose("Nata");
    const plain = await convert(body);
    const marked = await convert(body, {}, true);
    const { preview, ...rest } = marked;
    expect(rest).toEqual(plain);
    expect(preview![0].html).not.toContain('data-s="2"');
    expect(preview![0].html.match(/data-p="1"/g)).toHaveLength(1);
    expect(preview![0].html).toContain('<span data-p="2"></span>Një rresht');
  });

  // W3 Part 2: the W4 r2 audit's notes A1-A3 (Renato's 1a, 31 Oct).
  it("A1: 'make a chapter' on a title wins over 'not a chapter' on its label", async () => {
    const r = await convert(book, { notChapter: [5], makeChapter: [6] }, true);
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi", "Kthimi", "Kapitulli 3: Mbarimi"]);
    expect(r.sections[0].html).toContain("Kapitulli 2");
  });

  it("A2: ignores the author's mark-named bookmarks inside a link or a table cell, and the ebook stays the same", async () => {
    const bm = (name: string, id: number) => `<w:bookmarkStart w:id="${id}" w:name="${name}"/><w:bookmarkEnd w:id="${id}"/>`;
    const body =
      heading(1, "Liqeni") + prose("Dita") +
      `<w:p><w:hyperlink w:anchor="x">${bm("lbs_2", 7)}<w:r><w:t>Lidhje</w:t></w:r></w:hyperlink></w:p>` +
      `<w:tbl><w:tr><w:tc><w:p>${bm("lbp_1", 9)}<w:r><w:t>Qeliza</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` + prose("Nata");
    const plain = await convert(body);
    const marked = await convert(body, {}, true);
    const { preview, ...rest } = marked;
    expect(rest).toEqual(plain);
    expect(preview![0].html).not.toContain('data-s="2"');
    expect(preview![0].html.match(/data-p="1"/g)).toHaveLength(1);
    expect(preview![0].html).toContain('<span data-p="2"></span>Lidhje');
    expect(preview![0].html).toContain("<td><p>Qeliza</p></td>");
  });

  it("A3: 'keep apart' on a title typed on two lines keeps both title lines together as the next chapter", async () => {
    // Kapitulli 1 0, Fillimi 1, empty 2, Dita 3, Nata 4 | KAPITULLI 2 5, line 6, line 7, empty 8, Era 9, Shiu 10
    const two = chapter("Kapitulli 1", "Fillimi", true) + fmt("KAPITULLI 2", { ...look, pageBreakBefore: true }) +
      fmt("Udhëtimi i gjatë", look) + fmt("drejt shtëpisë", look) + emptyPara() + prose("Era") + prose("Shiu");
    const merged = await convert(two);
    expect(merged.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi", "KAPITULLI 2: Udhëtimi i gjatë drejt shtëpisë"]);
    const apart = await convert(two, { keepTitleApart: [5] }, true);
    expect(apart.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Fillimi", "KAPITULLI 2", "Udhëtimi i gjatë drejt shtëpisë"]);
    expect(apart.sections[2].headingLines).toEqual(["Udhëtimi i gjatë", "drejt shtëpisë"]);
    expect(apart.sections[1].html).toBe("");
    expect(apart.sections[2].html).toMatch(/^<p>Era/);
    expect(apart.cleanup.guesses.find((g) => g.kind === "merged_title" && g.paragraph === 5)).toMatchObject({ applied: false });
  });
});
