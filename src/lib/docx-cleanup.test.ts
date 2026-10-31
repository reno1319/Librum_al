import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupPassEnabled } from "./docx-cleanup";
import { convertDocxToDocument } from "./docx-converter";
import { buildDocxBytes, emptyPara, fmt, heading, hyperlinkParagraph, paragraph, prose, styledParagraph } from "./docx-test-fixtures";

// W3: the Word clean-up pass, end to end through convertDocxToDocument.
// All text is invented; the shapes copy what real manuscripts do
// (FINDINGS.md / REPORT.md, 31 Oct): chapter titles centered + bigger +
// on a new page, page break typed at the end of the previous paragraph,
// tab indents, empty lines for spacing, straight quotes and apostrophes.

async function convert(bodyXml: string, extra: Partial<Parameters<typeof buildDocxBytes>[0]> = {}, options = {}) {
  const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml, ...extra }), options);
  if (!result.success) throw new Error(`conversion failed: ${result.error}`);
  return result;
}

const title = (text: string) => fmt(text, { align: "center", size: 36 });
const lastBeforeBreak = (seed: string) => fmt(`${seed} dhe kështu mbaroi kjo pjesë e tregimit, pa zhurmë dhe pa lamtumirë.`, { tabs: 1, pageBreakAfter: true });

describe("W3 chapters typed by hand", () => {
  it("finds chapters that are centered, bigger and on a new page (no Heading styles)", async () => {
    const r = await convert(
      title("Liqeni") + emptyPara() + fmt("Fillimi i tregimit të parë, i gjatë sa duhet për të qenë tekst i zakonshëm.") + prose("Dita") + lastBeforeBreak("Nata") +
      title("Kodra e erës") + emptyPara() + prose("Mëngjesi") + prose("Mbrëmja"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Liqeni", "Kodra e erës"]);
    expect(r.cleanup.chapterSource).toBe("detected");
    expect(r.cleanup.chapters).toBe(2);
    const g = r.cleanup.guesses.find((x) => x.text === "Kodra e erës");
    expect(g).toMatchObject({ kind: "chapter", confidence: "high", applied: true });
    expect(g!.signs).toEqual(expect.arrayContaining(["new page", "centered", "bigger font"]));
  });

  it("finds 'Kapitulli' chapters after empty lines, and merges a label with its title line", async () => {
    const r = await convert(
      fmt("KAPITULLI I", { align: "center", bold: true, size: 32 }) + fmt("Mëngjesi", { align: "center", bold: true }) + emptyPara() +
      prose("Dita") + prose("Nata") + emptyPara(3) +
      fmt("Kapitulli 2", { align: "center", bold: true, size: 32 }) + fmt("Çelësi", { align: "center", bold: true }) + emptyPara() + prose("Era"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["KAPITULLI I: Mëngjesi", "Kapitulli 2: Çelësi"]);
    expect(r.sections[0].headingLines).toEqual(["KAPITULLI I", "Mëngjesi"]);
  });

  it("makes one chapter of 'Kapitulli 1' and a title line in the same big font (F3, answer 9a)", async () => {
    const look = { align: "center" as const, bold: true, size: 32 };
    const chapter = (label: string, name: string, first: boolean) =>
      fmt(label, { ...look, pageBreakBefore: !first }) + fmt(name, look) + emptyPara() + prose("Dita") + prose("Nata") + prose("Era");
    const r = await convert(chapter("Kapitulli 1", "Mëngjesi", true) + chapter("Kapitulli 2", "Çelësi", false) + chapter("Kapitulli 3", "Ura", false));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi", "Kapitulli 3: Ura"]);
    expect(r.sections.map((s) => s.headingLines)).toEqual([
      ["Kapitulli 1", "Mëngjesi"],
      ["Kapitulli 2", "Çelësi"],
      ["Kapitulli 3", "Ura"],
    ]);
    for (const s of r.sections) expect(s.html).toMatch(/^<p>Dita/);
    expect(r.cleanup.chapters).toBe(3);
  });

  it("keeps a single weak sign as normal text and reports it as an unsure guess", async () => {
    const r = await convert(prose("Dita") + fmt("Një vit më vonë", { bold: true }) + prose("Nata") + prose("Era"));
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].heading).toBeNull();
    expect(r.cleanup.guesses.find((g) => g.kind === "chapter")).toMatchObject({ confidence: "medium", applied: false });
  });

  it("applies the author's overrides from the preview", async () => {
    const body = prose("Dita") + fmt("Një vit më vonë", { bold: true }) + prose("Nata") + prose("Era");
    const made = await convert(body, {}, { makeChapter: [1] });
    expect(made.sections.map((s) => s.heading)).toEqual([null, "Një vit më vonë"]);
    const strong = title("Liqeni") + prose("Dita") + lastBeforeBreak("Nata") + title("Guri") + prose("Era");
    const unmade = await convert(strong, {}, { notChapter: [3] });
    expect(unmade.sections.map((s) => s.heading)).toEqual(["Liqeni"]);
    expect(unmade.cleanup.guesses.find((g) => g.text === "Guri")?.applied).toBe(false);
  });

  it("treats a bare centered 'I.' inside a story as a section heading, merged with its title line", async () => {
    const r = await convert(
      title("Ura") + prose("Dita") + emptyPara(2) + fmt("I.", { align: "center" }) + emptyPara() +
      fmt("DIMRI NË MAL", { align: "center" }) + emptyPara() + prose("Nata") + lastBeforeBreak("Era") +
      title("Guri") + prose("Mëngjesi"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Ura", "Guri"]);
    expect(r.sections[0].html).toContain("<h2>I.<br/>DIMRI NË MAL</h2>");
  });

  it("does not turn the lines of a typed title page into chapters", async () => {
    const r = await convert(
      fmt("LIBRI I DETIT", { align: "center", size: 44 }) + emptyPara(4) + fmt("Autor Prove", { align: "center", size: 30 }) + emptyPara(3) +
      fmt("Tiranë 2026", { align: "center", pageBreakAfter: true }) +
      title("Valët") + prose("Dita") + lastBeforeBreak("Nata") + title("Guri") + prose("Era"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual([null, "Valët", "Guri"]);
    expect(r.sections[0].html).toContain('<p class="center">LIBRI I DETIT</p>');
    expect(r.cleanup.guesses.find((g) => g.kind === "title_page")).toMatchObject({ applied: false });
  });

  it("trusts Heading 1 styles when the author used them", async () => {
    const r = await convert(heading(1, "Një") + fmt("Dy", { align: "center", size: 40, pageBreakBefore: true }) + prose("Dita"), { includeStyles: true });
    expect(r.cleanup.chapterSource).toBe("styles");
    expect(r.sections.map((s) => s.heading)).toEqual(["Një"]);
  });

  it("makes Heading 2 titles the chapters when the book has no Heading 1", async () => {
    const r = await convert(heading(2, "Vala") + fmt("Vjen e ikën,") + heading(2, "Guri") + fmt("Pret në rrugë."), { includeStyles: true });
    expect(r.sections.map((s) => s.heading)).toEqual(["Vala", "Guri"]);
  });

  it("writes Word's automatic heading number into the title", async () => {
    const numbering = `<w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="7"><w:abstractNumId w:val="3"/></w:num>`;
    const r = await convert(
      fmt("Mëngjesi", { style: "Heading1", numId: 7 }) + prose("Dita") + fmt("Çelësi", { style: "Heading1", numId: 7 }) + prose("Nata"),
      { includeStyles: true, includeNumbering: true, numberingXml: numbering },
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["I. Mëngjesi", "II. Çelësi"]);
    expect(r.cleanup.fixes.headingNumbersAdded).toBe(2);
  });

  it("leaves a footnote number on a chapter title out of the title text", async () => {
    const r = await convert(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>PARATHËNIE</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="2"/></w:r></w:p>` + prose("Dita"),
      { includeStyles: true, includeFootnotes: true },
    );
    expect(r.sections[0].heading).toBe("PARATHËNIE");
  });
});

describe("W3 chapter label + title merge (answer 9a, audits F3-F5)", () => {
  const big = { align: "center" as const, bold: true, size: 32 };
  const book = (parts: string[]) => parts.join("");
  const ch = (label: string, titleXml: string, first: boolean, gap = 0) =>
    fmt(label, { ...big, pageBreakBefore: !first }) + emptyPara(gap) + titleXml + emptyPara() + prose("Dita") + prose("Nata") + prose("Era") + prose("Shiu");

  it.each([0, 1, 2, 3])("merges the label and its title with %i empty lines between them", async (gap) => {
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big), true, gap), ch("Kapitulli 2", fmt("Çelësi", big), false, gap)]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
    expect(r.cleanup.guesses.filter((g) => g.kind === "merged_title").map((g) => g.applied)).toEqual([true, true]);
  });

  it("joins an empty label chapter to its title even across 4 or more empty lines (safety net, r6 H1)", async () => {
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big), true, 4), ch("Kapitulli 2", fmt("Çelësi", big), false, 6)]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
    expect(r.cleanup.guesses.filter((g) => g.kind === "merged_title").map((g) => g.signs[0])).toEqual([
      "empty chapter label joined to the next title",
      "empty chapter label joined to the next title",
    ]);
    const apart = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big), true, 4), ch("Kapitulli 2", fmt("Çelësi", big), false, 4)]), {}, { keepTitleApart: [0] });
    expect(apart.sections[0].heading).toBe("Kapitulli 1");
  });

  it.each([
    ["II", "Era"],
    ["2.", "Era"],
    ["KREU IV", "Kthimi"],
    ["Kapitulli i dytë", "Ura"],
  ])("merges '%s' with its title '%s'", async (label, name) => {
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big), true), ch(label, fmt(name, big), false)]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", `${label.replace(/[.:]$/, "")}: ${name}`]);
  });

  it("keeps a numbered poem's first verse line out of its title, and the poem centered (F4)", async () => {
    const poem = (n: string, first: boolean) =>
      fmt(n, { align: "center", size: 32, pageBreakBefore: !first }) +
      ["Era fryn mbi mal", "dhe guri hesht", "nata vjen ngadalë", "pa asnjë fjalë"].map((l) => fmt(l, { align: "center" })).join("");
    const r = await convert(prose("Hyrja") + poem("I", false) + poem("II", false) + poem("III", false));
    expect(r.sections.map((s) => s.heading)).toEqual([null, "I", "II", "III"]);
    for (const s of r.sections.slice(1)) expect(s.html).toMatch(/^<p class="(?:center|verse)">Era fryn mbi mal<\/p>/);
    expect(r.cleanup.guesses.filter((g) => g.kind === "merged_title")).toEqual([]);
  });

  it("does not merge a bold first line that opens a block of bold verse lines", async () => {
    const verse = ["Era fryn mbi mal", "dhe guri hesht", "nata vjen ngadalë"].map((l) => fmt(l, big)).join("");
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big), true), fmt("II", { ...big, pageBreakBefore: true }) + verse + prose("Dita")]));
    expect(r.cleanup.guesses.filter((g) => g.kind === "merged_title").map((g) => g.text)).toEqual(["Kapitulli 1: Mëngjesi"]);
    expect(r.sections[1].heading).toBe("II");
  });

  it("does not merge a numeral with a body paragraph or with a plain short centered line", async () => {
    const body = await convert(book([ch("Kapitulli 1", prose("Mëngjesi"), true), ch("Kapitulli 2", prose("Çelësi"), false)]));
    expect(body.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2"]);
    const plain = await convert(book([ch("Kapitulli 1", fmt("Një vit më vonë", { align: "center" }), true), ch("Kapitulli 2", fmt("Pas luftës", { align: "center" }), false)]));
    expect(plain.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2"]);
    expect(plain.cleanup.guesses.filter((g) => g.kind === "merged_title")).toEqual([]);
  });

  it("merges a Heading 1 label with the Heading 1 title right after it", async () => {
    const r = await convert(
      heading(1, "Kapitulli 1") + heading(1, "Mëngjesi") + prose("Dita") + heading(1, "Kapitulli 2") + heading(1, "Çelësi") + prose("Nata"),
      { includeStyles: true },
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
  });

  // Every merge probe from the audits (r4 b7b, r5 e1-e10, r6 f1-f12) stays a test.
  it("joins a title typed on two lines in the same look (r6 f1)", async () => {
    const two = (label: string, a: string, b: string, first: boolean) =>
      fmt(label, { ...big, pageBreakBefore: !first }) + fmt(a, big) + fmt(b, big) + emptyPara() + prose("Dita") + prose("Nata") + prose("Era") + prose("Shiu");
    const r = await convert(two("Kapitulli 1", "Ura mbi lumin", "e vjetër të qytetit", true) + two("Kapitulli 2", "Shtëpia në kodër", "pas pyllit të madh", false));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Ura mbi lumin e vjetër të qytetit", "Kapitulli 2: Shtëpia në kodër pas pyllit të madh"]);
    expect(r.sections[0].headingLines).toEqual(["Kapitulli 1", "Ura mbi lumin", "e vjetër të qytetit"]);
    for (const s of r.sections) expect(s.html).toMatch(/^<p>Dita/);
  });

  it("joins the title when a same-look line like '(1944)' follows it, and keeps that line (r6 f2)", async () => {
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big) + fmt("(1944)", big), true), ch("Kapitulli 2", fmt("Çelësi", big) + fmt("(1945)", big), false)]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
    expect(r.sections[0].html).toContain("(1944)");
  });

  it("joins a Heading 1 label with a title typed in a big font (r6 e6)", async () => {
    const r = await convert(
      heading(1, "Kapitulli 1") + fmt("Mëngjesi", big) + prose("Dita") + heading(1, "Kapitulli 2") + fmt("Çelësi", big) + prose("Nata"),
      { includeStyles: true },
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
  });

  it("never joins a plain label with a Heading 1 after it", async () => {
    const r = await convert(prose("Hyrja") + fmt("Kapitulli 1", big) + heading(1, "Mëngjesi") + prose("Dita"), { includeStyles: true });
    expect(r.cleanup.guesses.filter((g) => g.kind === "merged_title")).toEqual([]);
    expect(r.sections.map((s) => s.heading)).toContain("Mëngjesi");
  });

  it("mixes Heading 1 pairs and single Heading 1 chapters correctly (r6 f8)", async () => {
    const r = await convert(
      heading(1, "Parathënie") + prose("Dita") + heading(1, "Kapitulli 1") + heading(1, "Mëngjesi") + prose("Nata") + heading(1, "Pasthënie") + prose("Era"),
      { includeStyles: true },
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Parathënie", "Kapitulli 1: Mëngjesi", "Pasthënie"]);
  });

  it("keeps a part page ('Pjesa I' alone on its page) and joins the chapters inside it (r5 e7, r6 f12)", async () => {
    const r = await convert(
      prose("Hyrja") + fmt("Pjesa I", { ...big, pageBreakBefore: true }) +
        ch("Kapitulli 1", fmt("Mëngjesi", big), false) + ch("Kapitulli 2", fmt("Çelësi", big), false),
    );
    expect(r.sections.map((s) => s.heading)).toEqual([null, "Pjesa I", "Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
  });

  it("leaves a label alone when its title is on the next page, losing no text (r6 f12)", async () => {
    const r = await convert(
      prose("Hyrja") + fmt("Kapitulli 1", { ...big, pageBreakBefore: true }) + fmt("Mëngjesi", { ...big, pageBreakBefore: true }) + prose("Dita") +
        ch("Kapitulli 2", fmt("Çelësi", big), false),
    );
    const all = r.sections.map((s) => `${s.heading ?? ""} ${s.html}`).join(" ");
    for (const w of ["Hyrja", "Kapitulli 1", "Mëngjesi", "Dita", "Kapitulli 2", "Çelësi"]) expect(all).toContain(w);
    expect(r.sections.at(-1)!.heading).toBe("Kapitulli 2: Çelësi");
  });

  it("keeps a lone label's body: prose or dialogue right after it (r5 e2, e10)", async () => {
    const r = await convert(book([ch("Kapitulli 1", fmt("— Ku je?", { tabs: 1 }), true), ch("Kapitulli 2", prose("Era"), false)]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2"]);
    expect(r.sections[0].html).toContain("Ku je?");
  });

  it("does not take a 120-character line as a title (r5 e3)", async () => {
    const long = "Mëngjesi kur gjithçka ndryshoi për familjen e vogël që jetonte buzë liqenit të madh dhe nuk dinte asgjë për";
    const r = await convert(book([ch("Kapitulli 1", fmt(long, big), true), ch("Kapitulli 2", fmt("Çelësi", big), false)]));
    expect(r.sections[0].heading).toBe("Kapitulli 1");
    expect(r.sections[0].html).toContain(long);
  });

  it("joins a title followed by short dialogue lines (r6 f3)", async () => {
    const r = await convert(book([
      fmt("Kapitulli 1", big) + fmt("Mëngjesi", big) + fmt("— Ku je?", { tabs: 1 }) + fmt("— Këtu.", { tabs: 1 }) + prose("Dita"),
      ch("Kapitulli 2", fmt("Çelësi", big), false),
    ]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
  });

  it("joins 'II' with a big poem title, keeping the verse after it (r6 f7)", async () => {
    const verse = ["Era fryn mbi mal", "dhe guri hesht", "nata vjen ngadalë", "pa asnjë fjalë"].map((l) => fmt(l, { align: "center" })).join("");
    const r = await convert(prose("Hyrja") + fmt("II", { ...big, pageBreakBefore: true }) + fmt("Kënga 1", big) + verse);
    expect(r.sections.at(-1)!.heading).toBe("II: Kënga 1");
    expect(r.sections.at(-1)!.html).toContain("Era fryn mbi mal");
  });

  it("does not merge a bare '1' or '2.' with a big word inside a chapter body (r6 f9, f10)", async () => {
    const r = await convert(
      ch("Kapitulli 1", fmt("Mëngjesi", big), true) + prose("Dita") + fmt("1", { align: "center" }) + fmt("Nata", { align: "center" }) + prose("Era"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi"]);
    expect(r.cleanup.guesses.filter((g) => g.kind === "merged_title")).toHaveLength(1);
  });

  it("joins the title and keeps an italic epigraph after it in the body (r6 f11)", async () => {
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big) + fmt("Çdo fillim është i vështirë.", { align: "center", italic: true }), true), ch("Kapitulli 2", fmt("Çelësi", big), false)]));
    expect(r.sections[0].heading).toBe("Kapitulli 1: Mëngjesi");
    expect(r.sections[0].html).toContain("Çdo fillim është i vështirë.");
  });

  it("leaves a left-aligned title or an italic subtitle as the first body line, never an empty chapter (r6 f4, f5)", async () => {
    for (const titleXml of [fmt("Mëngjesi", { bold: true, size: 32 }), fmt("Mëngjesi", { align: "center", italic: true })]) {
      const r = await convert(book([ch("Kapitulli 1", titleXml, true), ch("Kapitulli 2", fmt("Çelësi", big), false)]));
      expect(r.sections[0].html).toContain("Mëngjesi");
      for (const s of r.sections) expect(s.html.length).toBeGreaterThan(0);
    }
  });

  it("keeps the label and the title apart when the author asks in the preview (keepTitleApart)", async () => {
    const r = await convert(book([ch("Kapitulli 1", fmt("Mëngjesi", big), true), ch("Kapitulli 2", fmt("Çelësi", big), false)]), {}, { keepTitleApart: [0] });
    expect(r.sections[0].heading).toBe("Kapitulli 1");
    expect(r.cleanup.guesses.find((g) => g.kind === "merged_title" && g.paragraph === 0)).toMatchObject({ applied: false });
  });
});

describe("W3 scene breaks and empty lines (answers 4a, 5a)", () => {
  it("makes two empty lines a scene break, and only suggests one for a single empty line (D1 = a)", async () => {
    const r = await convert(
      prose("Dita") + prose("Dielli") + prose("Java") + emptyPara(2) + prose("Nata") + prose("Era") + prose("Shiu") + emptyPara() + prose("Bora") + prose("Vera") + prose("Fundi"),
    );
    expect(r.sections[0].html).toMatch(/Java[^<]*<\/p><p class="scene-break">\* \* \*<\/p><p>Nata/);
    expect(r.sections[0].html.match(/scene-break/g)).toHaveLength(1);
    expect(r.cleanup.sceneBreaks).toBe(1);
    const breaks = r.cleanup.guesses.filter((g) => g.kind === "scene_break");
    expect(breaks.map((g) => [g.text.slice(0, 4), g.confidence, g.applied])).toEqual([
      ["Nata", "high", true],
      ["Bora", "medium", false],
    ]);
  });

  it("no break before a chapter's last paragraph from one empty line, but two empty lines still count (rule I)", async () => {
    const one = await convert(prose("Dita") + prose("Java") + prose("Nata") + emptyPara() + prose("Fundi"));
    expect(one.cleanup.guesses.filter((g) => g.kind === "scene_break")).toEqual([]);
    const two = await convert(prose("Dita") + prose("Java") + prose("Nata") + emptyPara(2) + prose("Fundi"));
    expect(two.sections[0].html).toMatch(/<p class="scene-break">\* \* \*<\/p><p>Fundi/);
  });

  it("decides spacing per chapter: a chapter with an empty line between every paragraph gets no breaks (R2)", async () => {
    const unspaced = prose("A1") + prose("A2") + prose("A3") + emptyPara() + prose("A4") + prose("A5") + prose("A6") + lastBeforeBreak("A7");
    const spaced = [prose("B1"), prose("B2"), prose("B3"), prose("B4"), prose("B5"), prose("B6"), prose("B7")].join(emptyPara()) +
      emptyPara(2) + prose("B8") + emptyPara() + prose("B9") + emptyPara() + prose("B10") + emptyPara() + prose("B11");
    const r = await convert(
      title("Liqeni") + unspaced + title("Guri") + spaced + emptyPara() + lastBeforeBreak("B12") +
      title("Era") + prose("C1") + prose("C2") + prose("C3") + prose("C4"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Liqeni", "Guri", "Era"]);
    // The spaced chapter: plain spacing; the one gap longer than its usual
    // one is only suggested.
    expect(r.sections[1].html).not.toContain("scene-break");
    const breaks = r.cleanup.guesses.filter((g) => g.kind === "scene_break");
    expect(breaks.map((g) => [g.text.slice(0, 3).trim(), g.applied])).toEqual([
      ["A4", false],
      ["B8", false],
    ]);
  });

  it("treats empty lines between dialogue lines as spacing, even when there are two (R2 density guard)", async () => {
    const line = (t: string) => fmt(`— ${t}`, { tabs: 1 });
    const r = await convert(
      prose("Dita") + prose("Java") + prose("Nata") + emptyPara(2) +
      [line("Ku je?"), line("Këtu."), line("Eja shpejt."), line("Po vij."), line("Mirë.")].join(emptyPara(2)) +
      prose("Era") + prose("Shiu") + prose("Fundi"),
    );
    expect(r.sections[0].html).not.toContain("scene-break");
    expect(r.cleanup.guesses.filter((g) => g.kind === "scene_break" && g.applied)).toEqual([]);
  });

  it("never splits a list with breaks, nor breaks after a line ending in ':' (R3)", async () => {
    const r = await convert(
      prose("Dita") + prose("Java") + fmt("Letra thoshte kështu:", { tabs: 1 }) + emptyPara(2) + prose("Nata") + prose("Era") +
      fmt("molla", { numId: 1 }) + emptyPara(2) + fmt("dardha", { numId: 1 }) + emptyPara(2) + fmt("rrush", { numId: 1 }) +
      prose("Shiu") + prose("Bora") + prose("Fundi"),
      { includeNumbering: true },
    );
    expect(r.sections[0].html).not.toContain("scene-break");
    expect(r.sections[0].html.match(/<ul>/g)).toHaveLength(1);
    expect(r.cleanup.guesses.filter((g) => g.kind === "scene_break")).toEqual([]);
  });

  it("ignores empty lines when the author puts one between most paragraphs", async () => {
    const body = [prose("A"), prose("B"), prose("C"), prose("D"), prose("E"), prose("F")].join(emptyPara());
    const r = await convert(body);
    expect(r.sections[0].html).not.toContain("scene-break");
    expect(r.cleanup.fixes.emptyLinesRemoved).toBe(5);
  });

  it("never makes a scene break from empty lines next to a title, a centered line or an italic quote", async () => {
    const r = await convert(
      title("Liqeni") + emptyPara(2) + prose("Dita") + emptyPara() + fmt("Era fryn mbi kodër,", { italic: true }) + emptyPara() +
      prose("Nata") + emptyPara() + fmt("— Plaku i fshatit", { align: "right" }) + emptyPara() + prose("Era") + prose("Fundi"),
    );
    expect(r.sections[0].html).not.toContain("scene-break");
    expect(r.sections[0].html).toContain('<p class="right">— Plaku i fshatit</p>');
  });

  it("turns typed markers into the same centered * * *, but not at a chapter's start", async () => {
    const r = await convert(
      prose("Dita") + fmt("***", { align: "center" }) + prose("Nata") + fmt("#") + prose("Era"),
    );
    expect(r.sections[0].html.match(/<p class="scene-break">\* \* \*<\/p>/g)).toHaveLength(2);
    expect(r.sections[0].html).not.toContain("***");
    const atStart = await convert(title("Liqeni") + fmt("* * *") + prose("Dita") + lastBeforeBreak("Nata") + title("Guri") + prose("Era"));
    expect(atStart.sections[0].html).not.toContain("* * *");
  });
});

describe("W3 permanent cases from the list-rule and spacing sweeps (audits r2, r4, r7)", () => {
  const big = { align: "center" as const, size: 36 };
  // Hand-typed chapters: centered, bigger, each after a page break.
  const chapters = (names: string[]) =>
    names.map((name, i) => fmt(name, big) + prose("Dita") + prose("Nata") + (i < names.length - 1 ? lastBeforeBreak("Era") : prose("Era"))).join("");
  const removedLines = (r: Awaited<ReturnType<typeof convert>>) => r.cleanup.fixes.contentsLinesRemoved;
  const listGuess = (r: Awaited<ReturnType<typeof convert>>) => r.cleanup.guesses.find((g) => g.kind === "typed_contents");

  it("keeps a chronology with years before chapter 1 (r4 a5)", async () => {
    const r = await convert(
      fmt("Kronologjia") + fmt("Lindja\t1920") + fmt("Shkolla\t1932") + fmt("Lufta\t1940", { pageBreakAfter: true }) + chapters(["Liqeni", "Guri"]),
    );
    expect(r.sections[0].html).toMatch(/Lindja[\s\S]*Shkolla[\s\S]*Lufta/);
    expect(removedLines(r)).toBe(0);
    expect(listGuess(r)).toMatchObject({ applied: false });
  });

  it("removes a contents list at the end of the book under 'Lënda' (r4 b2)", async () => {
    const r = await convert(
      chapters(["Liqeni", "Guri", "Era"]).replace(/<\/w:t><\/w:r><\/w:p>$/, '</w:t><w:br w:type="page"/></w:r></w:p>') +
        fmt("Lënda") + fmt("Liqeni\t3") + fmt("Guri\t14") + fmt("Era\t27"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Liqeni", "Guri", "Era"]);
    expect(r.sections.at(-1)!.html).not.toMatch(/Lënda|\t27/);
    expect(removedLines(r)).toBe(4);
  });

  it("removes a list typed as '1. Liqeni⇥3' with no title before hand-typed chapters (r4 b4)", async () => {
    const r = await convert(fmt("1. Liqeni\t3") + fmt("2. Guri\t14") + fmt("3. Era\t27", { pageBreakAfter: true }) + chapters(["Liqeni", "Guri", "Era"]));
    expect(r.sections.map((s) => s.heading)).toEqual(["Liqeni", "Guri", "Era"]);
    expect(removedLines(r)).toBe(3);
  });

  it("removes a list with extra lines when most of its lines are chapters (r4 b5: 5 of 7)", async () => {
    const r = await convert(
      fmt("Parathënie\tv") + fmt("Liqeni\t1") + fmt("Guri\t9") + fmt("Era\t17") + fmt("Ura\t25") + fmt("Kodra\t33") +
        fmt("Pasthënie\t48", { pageBreakAfter: true }) + chapters(["Liqeni", "Guri", "Era", "Ura", "Kodra"]),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Liqeni", "Guri", "Era", "Ura", "Kodra"]);
    expect(removedLines(r)).toBe(7);
    expect(listGuess(r)!.signs).toContain("5 of them are chapter titles");
  });

  it("keeps a list when only half its lines are chapters, or when it words them differently (r4 b6, b3)", async () => {
    const half = await convert(
      fmt("Parathënie\tv") + fmt("Liqeni\t1") + fmt("Guri\t9") + fmt("Pasthënie\t17", { pageBreakAfter: true }) + chapters(["Liqeni", "Guri"]),
    );
    expect(removedLines(half)).toBe(0);
    expect(listGuess(half)).toMatchObject({ applied: false, confidence: "medium" });
    const worded = await convert(
      fmt("Te liqeni\t1") + fmt("Mbi gurin\t9") + fmt("Kur fryn era\t17", { pageBreakAfter: true }) + chapters(["Liqeni", "Guri", "Era"]),
    );
    expect(removedLines(worded)).toBe(0);
    expect(worded.sections[0].html).toMatch(/Te liqeni[\s\S]*Kur fryn era/);
  });

  it("removes a list naming only the titles of 'Kapitulli N' + title chapters, and merges the chapters (r4 b7)", async () => {
    const look = { align: "center" as const, bold: true, size: 32 };
    const ch = (n: number, name: string, last: boolean) =>
      fmt(`Kapitulli ${n}`, look) + fmt(name, look) + prose("Dita") + prose("Nata") + (last ? prose("Era") : lastBeforeBreak("Era"));
    const r = await convert(
      fmt("Mëngjesi\t3") + fmt("Çelësi\t11") + fmt("Ura\t19", { pageBreakAfter: true }) + ch(1, "Mëngjesi", false) + ch(2, "Çelësi", false) + ch(3, "Ura", true),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi", "Kapitulli 3: Ura"]);
    expect(removedLines(r)).toBe(3);
  });

  it("makes no scene breaks in a book with no chapters that is double-spaced throughout, or in a pasted double-spaced block (r2 s5, s5b)", async () => {
    const paras = Array.from({ length: 15 }, (_, i) => prose(`P${i}`));
    const whole = await convert(paras.join(emptyPara(2)));
    expect(whole.sections).toHaveLength(1);
    expect(whole.sections[0].html).not.toContain("scene-break");
    expect(whole.cleanup.guesses.filter((g) => g.kind === "scene_break")).toEqual([]);
    const pasted = await convert(
      prose("A1") + prose("A2") + prose("A3") + prose("A4") + paras.join(emptyPara(2)) + prose("B1") + prose("B2") + prose("B3") + prose("B4"),
    );
    expect(pasted.sections[0].html).not.toContain("scene-break");
    expect(pasted.cleanup.guesses.filter((g) => g.kind === "scene_break" && g.applied)).toEqual([]);
  });

  it("keeps 'Pjesa I' alone when its page break is typed at the end of its own paragraph (r7 p2)", async () => {
    const look = { align: "center" as const, bold: true, size: 32 };
    const r = await convert(
      prose("Hyrja") + lastBeforeBreak("Fundi") + fmt("Pjesa I", { ...look, pageBreakAfter: true }) +
        fmt("Kapitulli 1", look) + fmt("Mëngjesi", look) + prose("Dita") + prose("Nata") + lastBeforeBreak("Era") +
        fmt("Kapitulli 2", look) + fmt("Çelësi", look) + prose("Dita") + prose("Nata") + prose("Era"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual([null, "Pjesa I", "Kapitulli 1: Mëngjesi", "Kapitulli 2: Çelësi"]);
    expect(r.sections[1].html).toBe("");
  });
});

describe("W3 tidying", () => {
  it("removes a typed contents list with page numbers, and its title", async () => {
    const r = await convert(
      fmt("Përmbajtja") + fmt("Tregimi i parë ............ 3") + fmt("Tregimi i dytë\t17") + fmt("Tregimi i tretë ...... 29") + prose("Dita") +
        heading(1, "Tregimi i parë") + prose("Nata") + heading(1, "Tregimi i dytë") + prose("Era") + heading(1, "Tregimi i tretë") + prose("Shiu"),
      { includeStyles: true },
    );
    expect(r.sections[0].html).not.toMatch(/Përmbajtja|Tregimi i/);
    expect(r.cleanup.fixes.contentsLinesRemoved).toBe(4);
  });

  it("keeps a recipe or a timetable that looks like a contents list, and reports it as unsure (R1)", async () => {
    const r = await convert(
      prose("Dita") + prose("Java") + fmt("Miell\t\t500") + fmt("Sheqer\t\t200") + fmt("Gjalpë\t\t100") + fmt("Vezë\t\t3") +
      prose("Nata") + fmt("Nisja ........ 8") + fmt("Pushimi ........ 12") + fmt("Kthimi ........ 17") + prose("Era"),
    );
    expect(r.sections[0].html).toMatch(/Miell[\s\S]*Sheqer[\s\S]*Gjalpë[\s\S]*Vezë/);
    expect(r.sections[0].html).toMatch(/Nisja[\s\S]*Pushimi[\s\S]*Kthimi/);
    expect(r.cleanup.fixes.contentsLinesRemoved).toBe(0);
    const toc = r.cleanup.guesses.filter((g) => g.kind === "typed_contents");
    expect(toc.map((g) => [g.text.slice(0, 5), g.applied])).toEqual([
      ["Miell", false],
      ["Nisja", false],
    ]);
  });

  it("removes a typed contents list whose lines are the chapter titles found, but not one whose numbers go down", async () => {
    const chapters = title("Liqeni") + prose("Dita") + lastBeforeBreak("Java") + title("Guri") + prose("Nata") + lastBeforeBreak("Bora") + title("Era") + prose("Shiu");
    const front = await convert(fmt("Hyrje\tix") + fmt("Liqeni\t1") + fmt("Guri\t14") + fmt("Era\t27", { pageBreakAfter: true }) + chapters);
    expect(front.sections.map((s) => s.heading)).toEqual(["Liqeni", "Guri", "Era"]);
    expect(front.sections[0].html).not.toMatch(/Hyrje|\t1/);
    expect(front.cleanup.fixes.contentsLinesRemoved).toBe(4);
    expect(front.cleanup.guesses.find((g) => g.kind === "typed_contents")?.signs).toContain("3 of them are chapter titles");
    const down = await convert(fmt("Përmbajtja") + fmt("Liqeni\t30") + fmt("Guri\t14") + fmt("Era\t2", { pageBreakAfter: true }) + chapters);
    expect(down.sections[0].html).toMatch(/Liqeni[\s\S]*Guri[\s\S]*Era/);
    expect(down.cleanup.guesses.find((g) => g.kind === "typed_contents")).toMatchObject({ applied: false, confidence: "medium" });
  });

  it("keeps a cookbook's first ingredient list, even before any long sentence (F1)", async () => {
    const recipe = (name: string) =>
      heading(1, name) + fmt("Përbërësit:") + fmt("Vezë\t\t2") + fmt("Sheqer\t\t100") + fmt("Miell\t\t250") + prose("Përzieni");
    const r = await convert(recipe("Kek me mollë") + recipe("Petulla"), { includeStyles: true });
    expect(r.sections.map((s) => s.heading)).toEqual(["Kek me mollë", "Petulla"]);
    for (const s of r.sections) expect(s.html).toMatch(/Vezë[\s\S]*Sheqer[\s\S]*Miell/);
    expect(r.cleanup.fixes.contentsLinesRemoved).toBe(0);
    expect(r.cleanup.guesses.filter((g) => g.kind === "typed_contents").map((g) => g.applied)).toEqual([false, false]);
  });

  it("keeps a timetable inside a poetry book that has no long sentence anywhere (F1)", async () => {
    const verse = (a: string) => fmt(`${a} mbi ujë`) + fmt("dhe hëna e lodhur") + fmt("pa zë në breg") + fmt("pret anijen");
    const r = await convert(
      title("Valët") + verse("Era") + lastBeforeBreak("Fundi") +
      title("Orari i trenit") + fmt("Nisja\t\t6") + fmt("Durrësi\t\t8") + fmt("Vlora\t\t11") + verse("Treni"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Valët", "Orari i trenit"]);
    expect(r.sections[1].html).toMatch(/Nisja[\s\S]*Durrësi[\s\S]*Vlora/);
    expect(r.cleanup.guesses.find((g) => g.kind === "typed_contents")).toMatchObject({ applied: false, confidence: "medium" });
  });

  it("keeps an ingredient list whose words come back in short recipe steps (F2)", async () => {
    const r = await convert(
      heading(1, "Kek me mollë") + fmt("Përbërësit:") + fmt("Vezë\t\t2") + fmt("Sheqer\t\t100") + fmt("Miell\t\t250") +
        fmt("Rrihni dy vezë") + fmt("Shtoni sheqer") + fmt("Në fund hidhni miell") + heading(1, "Petulla") + prose("Përzieni"),
      { includeStyles: true },
    );
    expect(r.sections[0].html).toMatch(/Vezë[\s\S]*Sheqer[\s\S]*Miell[\s\S]*Shtoni sheqer/);
    expect(r.cleanup.fixes.contentsLinesRemoved).toBe(0);
    expect(r.cleanup.guesses.find((g) => g.kind === "typed_contents")).toMatchObject({ applied: false, confidence: "medium" });
  });

  it("keeps a timetable whose city names come back in later dialogue (F2)", async () => {
    const r = await convert(
      title("Udhëtimi") + prose("Dita") + fmt("Orari ishte ky:") + fmt("Nisja nga Tirana\t\t6") + fmt("Durrësi\t\t8") + fmt("Vlora\t\t11") +
        prose("Nata") + fmt("— Mbërritëm në Durrësi.", { tabs: 1 }) + fmt("Pastaj erdhi Vlora", { tabs: 1 }) + lastBeforeBreak("Era") +
        title("Kthimi") + prose("Shiu") + fmt("Durrësi") + prose("Bora"),
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Udhëtimi", "Kthimi"]);
    expect(r.sections[0].html).toMatch(/Nisja nga Tirana[\s\S]*Durrësi[\s\S]*Vlora/);
    expect(r.cleanup.fixes.contentsLinesRemoved).toBe(0);
    expect(r.cleanup.guesses.find((g) => g.kind === "typed_contents")).toMatchObject({ applied: false });
  });

  it("brings back a removed contents list when the author asks in the preview (keepContents)", async () => {
    const body = fmt("Përmbajtja") + fmt("Tregimi i parë ............ 3") + fmt("Tregimi i dytë\t17") + fmt("Tregimi i tretë ...... 29") + prose("Dita");
    const kept = await convert(body, {}, { keepContents: [1] });
    expect(kept.sections[0].html).toMatch(/Përmbajtja[\s\S]*Tregimi i parë[\s\S]*Tregimi i tretë/);
    expect(kept.cleanup.fixes.contentsLinesRemoved).toBe(0);
    expect(kept.cleanup.guesses.find((g) => g.kind === "typed_contents")).toMatchObject({ paragraph: 1, applied: false });
  });

  it("removes Word's own contents lines (links to _Toc bookmarks) and their title", async () => {
    const r = await convert(
      styledParagraph("TOCHeading", "Përmbajtja") +
        `<w:p><w:hyperlink w:anchor="_Toc1"><w:r><w:t>Një</w:t></w:r></w:hyperlink></w:p>` +
        `<w:p><w:hyperlink w:anchor="_Toc2"><w:r><w:t>Dy</w:t></w:r></w:hyperlink></w:p>` +
        heading(1, "Një") + prose("Dita") + heading(1, "Dy") + prose("Nata"),
      { includeStyles: true, extraParagraphStyles: [{ id: "TOCHeading", name: "TOC Heading" }] },
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Një", "Dy"]);
  });

  it("strips tab and space indents, keeps deeper-indented poem lines as an indented block", async () => {
    const r = await convert(
      prose("Dita") + prose("Nata") + fmt("Një lumë i ngadaltë,", { tabs: 3 }) + fmt("me ujë të ftohtë.", { tabs: 3 }) + prose("Era"),
    );
    expect(r.sections[0].html).not.toContain("\t");
    expect(r.sections[0].html).toContain('<p class="verse-indent">Një lumë i ngadaltë,</p>');
    expect(r.cleanup.fixes.indentsRemoved).toBe(5);
  });

  it("keeps a poem typed one line per paragraph together, with stanza gaps", async () => {
    const r = await convert(
      prose("Dita") + fmt("Një gur në rrugë,") + fmt("i heshtur, i rëndë,") + emptyPara() + fmt("pret çdo hap,") + fmt("pret çdo këngë") + prose("Nata"),
    );
    expect(r.sections[0].html).toContain('<p class="verse">Një gur në rrugë,</p><p class="verse">i heshtur, i rëndë,</p><p class="verse-stanza">pret çdo hap,</p>');
  });

  it("splits prose typed with Shift+Enter into real paragraphs", async () => {
    const long = "Mëngjesi në qytet ishte i ftohtë dhe i qetë, por askush nuk e dinte se çfarë do të ndodhte";
    const r = await convert(`<w:p><w:r><w:t>${long}.</w:t><w:br/><w:t xml:space="preserve">    ${long}!</w:t></w:r></w:p>`);
    expect(r.sections[0].html).toBe(`<p>${long}.</p><p>${long}!</p>`);
    expect(r.cleanup.guesses.find((g) => g.kind === "split_lines")).toMatchObject({ paragraph: 0, applied: true });
    // The preview can undo it.
    const kept = await convert(`<w:p><w:r><w:t>${long}.</w:t><w:br/><w:t xml:space="preserve">    ${long}!</w:t></w:r></w:p>`, {}, { keepLines: [0] });
    expect(kept.sections[0].html).toMatch(/^<p>[^<]*\.<br\/>[^<]*!<\/p>$/);
    expect(kept.cleanup.guesses.find((g) => g.kind === "split_lines")?.applied).toBe(false);
  });

  it("glues a drop cap back to its word", async () => {
    const r = await convert(
      `<w:p><w:pPr><w:framePr w:dropCap="drop" w:lines="3"/></w:pPr><w:r><w:rPr><w:sz w:val="96"/></w:rPr><w:t>D</w:t></w:r></w:p>` + fmt("ita filloi herët.") + prose("Nata"),
    );
    expect(r.sections[0].html).toContain("<p>Dita filloi herët.</p>");
    expect(r.cleanup.fixes.dropCapsJoined).toBe(1);
  });

  it("follows the author's quote habit: curly by default, „…“ when the book uses it, off when switched off", async () => {
    const plain = await convert(fmt('Ai tha: "Po" dhe s\'e pa më... -- fund.'));
    expect(plain.sections[0].html).toBe("<p>Ai tha: “Po” dhe s’e pa më… — fund.</p>");
    expect(plain.cleanup.quoteStyle).toBe("curly");
    const low9 = await convert(fmt("Ajo tha: „Jo“.") + fmt('Ai tha: "Po".'));
    expect(low9.sections[0].html).toContain("<p>Ai tha: „Po“.</p>");
    const off = await convert(fmt('Ai tha: "Po".'), {}, { fixQuotes: false });
    expect(off.sections[0].html).toBe('<p>Ai tha: "Po".</p>');
    expect(off.cleanup.quoteStyle).toBe("off");
  });

  it("gives hyphen dialogue the dash the author uses most", async () => {
    const r = await convert(fmt("– Po, – tha ai.") + fmt("– Jo.") + fmt("- Ndoshta, - tha ajo."));
    expect(r.sections[0].html).toContain("<p>– Ndoshta, – tha ajo.</p>");
  });
});

describe("W3 Part 2: a blank line around centered lines (Renato's staging try-out, answer 4a)", () => {
  const center = (text: string, italic = false) => fmt(text, { align: "center", italic });
  const chapter = (body: string) => heading(1, "Kreu") + prose("Dita") + body;
  const gaps = (html: string) => (html.match(/<p class="gap">\u00a0<\/p>/g) ?? []).length;

  it("keeps one blank line above and below a centered heading line typed between empty lines", async () => {
    const r = await convert(chapter(emptyPara(2) + center("RENDI I NGJARJEVE") + emptyPara() + prose("Nata") + prose("Era")), { includeStyles: true });
    expect(r.sections[0].html).toMatch(
      /Dita[^<]*<\/p><p class="gap">\u00a0<\/p><p class="center">RENDI I NGJARJEVE<\/p><p class="gap">\u00a0<\/p><p>Nata/,
    );
    expect(r.cleanup.gaps).toBe(2);
  });

  it("keeps the gap around a centered italic couplet, with its two lines tight", async () => {
    const r = await convert(chapter(emptyPara() + center("Hëna fle mbi ujë,", true) + center("era s’e zgjon dot.", true) + emptyPara() + prose("Nata")), { includeStyles: true });
    expect(r.sections[0].html).toContain(
      '<p class="gap">\u00a0</p><p class="center"><em>Hëna fle mbi ujë,</em></p><p class="center"><em>era s’e zgjon dot.</em></p><p class="gap">\u00a0</p><p>Nata',
    );
  });

  it("keeps a centered poem tight inside, with one gap around it", async () => {
    const poem = ["Mali i lartë", "guri i ftohtë", "lumi që ikën", "dhe zogu që rri"].map((l) => center(l)).join("");
    const r = await convert(chapter(emptyPara() + poem + emptyPara() + prose("Nata")), { includeStyles: true });
    expect(gaps(r.sections[0].html)).toBe(2);
    // (A 4-line centered poem is a verse block today; centering poems is W6.)
    expect(r.sections[0].html).toMatch(/<p class="gap">\u00a0<\/p><p class="(?:verse|center)">Mali i lartë<\/p><p class="(?:verse|center)">guri i ftohtë<\/p><p class="(?:verse|center)">lumi që ikën<\/p><p class="(?:verse|center)">dhe zogu që rri<\/p><p class="gap">\u00a0<\/p><p>Nata/);
  });

  it("is one blank line however many empty lines were typed, and right-aligned lines get it too", async () => {
    const r = await convert(chapter(emptyPara(5) + fmt("— Një letër e vjetër", { align: "right" }) + emptyPara(4) + prose("Nata")), { includeStyles: true });
    expect(r.sections[0].html).toContain('<p class="gap">\u00a0</p><p class="right">— Një letër e vjetër</p><p class="gap">\u00a0</p><p>Nata');
    expect(gaps(r.sections[0].html)).toBe(2);
  });

  it("adds no gap where Word had none, at a chapter start, or between ordinary paragraphs", async () => {
    const r = await convert(
      heading(1, "Kreu") + emptyPara(2) + center("Motoja e kreut") + prose("Dita") + center("Pa rresht bosh") + prose("Nata") + emptyPara() + prose("Era"),
      { includeStyles: true },
    );
    expect(gaps(r.sections[0].html)).toBe(0);
    expect(r.cleanup.gaps).toBe(0);
  });

  it("adds no gap next to a chapter title, the same on Production, and none with the clean-up switched off", async () => {
    const body = chapter(emptyPara() + center("Fundi i pjesës") + emptyPara(2) + heading(1, "Kreu tjetër") + prose("Nata"));
    const r = await convert(body, { includeStyles: true });
    expect(r.sections[0].html).toMatch(/<p class="gap">\u00a0<\/p><p class="center">Fundi i pjesës<\/p>$/);
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCX_CLEANUP_OFF", "");
    const prod = await convert(body, { includeStyles: true });
    expect(prod.sections[0].html).toBe(r.sections[0].html);
    vi.stubEnv("DOCX_CLEANUP_OFF", "1");
    const off = await convert(body, { includeStyles: true });
    expect(off.sections[0].html).not.toContain("gap");
    vi.unstubAllEnvs();
  });

  // Renato's audit answer Q1a (31 Oct): a page break inside a chapter
  // counts like empty lines, so the line is never stuck to the text above.
  it.each([
    ["before the centered line", fmt("KRONOLOGJI", { align: "center", pageBreakBefore: true }), prose("Dita")],
    ["after the paragraph above it", center("KRONOLOGJI"), fmt("Dita", { pageBreakAfter: true })],
  ])("keeps one blank line above a centered line after a page break %s, and one below", async (_name, line, above) => {
    const r = await convert(heading(1, "Kreu") + prose("Mëngjesi") + above + line + emptyPara(2) + prose("Nata") + prose("Era") + prose("Shiu"), {
      includeStyles: true,
    });
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].html).toMatch(/Dita[^<]*<\/p><p class="gap">\u00a0<\/p><p class="center">KRONOLOGJI<\/p><p class="gap">\u00a0<\/p><p>Nata/);
    expect(gaps(r.sections[0].html)).toBe(2);
  });

  it("adds no gap for a page break between ordinary paragraphs, or before a chapter title", async () => {
    const r = await convert(
      heading(1, "Kreu") + prose("Mëngjesi") + fmt("Dita", { pageBreakBefore: true }) + center("Fundi", false) + fmt("Kreu tjetër", { pageBreakBefore: true, align: "center" }).replace("<w:pPr>", '<w:pPr><w:pStyle w:val="Heading1"/>') + prose("Nata"),
      { includeStyles: true },
    );
    expect(r.sections.map((s) => s.heading)).toEqual(["Kreu", "Kreu tjetër"]);
    expect(r.sections.map((s) => gaps(s.html))).toEqual([0, 0]);
  });
});

describe("W3 tracked changes and links", () => {
  it("uses the final text of tracked changes and warns the author (answer 7a)", async () => {
    const r = await convert(
      `<w:p><w:r><w:t xml:space="preserve">Teksti </w:t></w:r><w:del w:id="1" w:author="A"><w:r><w:delText>i vjetër</w:delText></w:r></w:del><w:ins w:id="2" w:author="A"><w:r><w:t>i ri</w:t></w:r></w:ins></w:p>`,
    );
    expect(r.sections[0].html).toBe("<p>Teksti i ri</p>");
    expect(r.cleanup.trackedChanges).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("tracked_changes_accepted");
  });

  it("warns when the file has comments", async () => {
    const r = await convert(`<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>Teksti.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>`);
    expect(r.cleanup.comments).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("tracked_changes_accepted");
  });

  it("no warning for a clean file", async () => {
    const r = await convert(paragraph("Teksti."));
    expect(r.warnings).toEqual([]);
    expect(r.cleanup.applied).toBe(true);
  });

  it("writes a link address containing & once escaped, never &amp;amp;", async () => {
    const r = await convert(hyperlinkParagraph("rIdL", "faqja"), {
      includeHyperlinkRel: [{ id: "rIdL", target: "https://example.com/?a=1&amp;b=2" }],
    });
    expect(r.sections[0].html).toContain('<a href="https://example.com/?a=1&amp;b=2">faqja</a>');
    expect(r.sections[0].html).not.toContain("&amp;amp;");
  });

  it("converts the original file as before when the clean-up pass can't read it", async () => {
    // A <!DOCTYPE> is refused by the clean-up reader; Mammoth reads the file.
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(await buildDocxBytes({ bodyXml: paragraph('Ai tha: "Po".') }));
    const xml = await zip.file("word/document.xml")!.async("string");
    zip.file("word/document.xml", xml.replace("<w:document", "<!DOCTYPE w:document>\n<w:document"));
    const r = await convertDocxToDocument(await zip.generateAsync({ type: "nodebuffer" }));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.cleanup.applied).toBe(false);
    expect(r.sections[0].html).toBe('<p>Ai tha: "Po".</p>');
  });
});

describe("W3 runs everywhere unless DOCX_CLEANUP_OFF is set (answers 1a/2a, 31 Oct)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is on in every environment, Production included, when the switch is unset or empty", () => {
    expect(cleanupPassEnabled({})).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "preview" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "development" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "production" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL_ENV: "production" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "production", DOCX_CLEANUP_OFF: "" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "production", DOCX_CLEANUP_OFF: "  " })).toBe(true);
  });

  it.each(["1", "true", "off", "OFF", "0", "false", "no", " 1 ", "yes please"])(
    "any non-empty switch value (%j) turns it off, in every environment",
    (value) => {
      expect(cleanupPassEnabled({ DOCX_CLEANUP_OFF: value })).toBe(false);
      expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "production", DOCX_CLEANUP_OFF: value })).toBe(false);
      expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "preview", DOCX_CLEANUP_OFF: value })).toBe(false);
    },
  );

  // Audit W3SW r1.
  it("treats whitespace-only values (tab, newline, no-break space) as unset, so on", () => {
    for (const v of ["\t", "\n", " \r\n ", "\u00a0"]) {
      expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "production", DOCX_CLEANUP_OFF: v })).toBe(true);
    }
  });

  it("ignores the old Vercel markers: unknown environment names are on, and the switch wins everywhere", () => {
    expect(cleanupPassEnabled({ VERCEL: "1", VERCEL_ENV: "staging" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL_ENV: "something-else" })).toBe(true);
    expect(cleanupPassEnabled({ VERCEL: "1", DOCX_CLEANUP_OFF: "x" })).toBe(false);
    expect(cleanupPassEnabled({ VERCEL_ENV: "development", DOCX_CLEANUP_OFF: "x" })).toBe(false);
  });

  it("reads process.env by default", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCX_CLEANUP_OFF", "");
    expect(cleanupPassEnabled()).toBe(true);
    vi.stubEnv("DOCX_CLEANUP_OFF", "1");
    expect(cleanupPassEnabled()).toBe(false);
  });

  it("cleans up on Production when the switch is unset", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCX_CLEANUP_OFF", "");
    const r = await convert(
      title("Liqeni") + fmt("Kapitulli 1", { align: "center", bold: true }) + prose("Dita") + emptyPara(2) + prose("Nata") + fmt('Ai tha: "Po".'),
    );
    expect(r.cleanup.applied).toBe(true);
    expect(r.sections[0].html).not.toContain('"Po"');
  });

  it("converts exactly as before W3 when the clean-up is switched off", async () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("DOCX_CLEANUP_OFF", "1");
    const r = await convert(
      title("Liqeni") + fmt("Kapitulli 1", { align: "center", bold: true }) + prose("Dita") + emptyPara(2) + prose("Nata") + fmt('Ai tha: "Po".'),
    );
    expect(r.cleanup.applied).toBe(false);
    expect(r.cleanup.guesses).toEqual([]);
    expect(r.sections).toHaveLength(1);
    expect(r.sections[0].html).not.toContain("scene-break");
    expect(r.sections[0].html).toContain('Ai tha: "Po".');
    expect(r.sections[0].html).toContain("<p>\tDita");
  });
});
