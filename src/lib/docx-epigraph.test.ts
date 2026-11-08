import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertDocxToDocument } from "./docx-converter";
import { buildDocxBytes, fmt } from "./docx-test-fixtures";
import { canToggleGuess, describeGuess, emptyChoices, healthReport, normalizeChoices, toggleGuess } from "./docx-preview-choices";
import { generateEpub } from "./epub-generator";
import { validateEpubStructure } from "./epub-validation";
import { parseChapterXhtml, type PreviewNode } from "./ebook-preview-html";

// KP2: chapter-opening epigraphs (Renato's staging Kindle check, 7 Nov
// 2026; rules agreed the same day). Every quote and name here is
// invented.

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
const LONG = "Ajo ishte një ditë e zakonshme në qytet, me njerëz që shkonin në punë dhe fëmijë që vraponin drejt shkollës.";
const body = (seed: string) => fmt(`${seed} ${LONG}`);
const story = (title: string) => fmt(title, { style: "Heading1", size: 28, align: "center" });
const tail = story("GURI") + body("E mërkura.") + body("E enjtja.");

async function convert(bodyXml: string, options = {}) {
  const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml, includeStyles: true }), options);
  if (!result.success) throw new Error(`conversion failed: ${result.error}`);
  return result;
}
type Result = Awaited<ReturnType<typeof convert>>;
const epigraphs = (r: Result) => r.cleanup.guesses.filter((g) => g.kind === "epigraph");
const firstChapter = (r: Result) => r.sections.find((s) => s.heading === "DETI")!.html;
const classes = (html: string) => [...html.matchAll(/<p(?: class="([^"]+)")?>/g)].map((m) => m[1] ?? "");

const chapter = (opening: string) => story("DETI") + opening + body("E hëna.") + body("E marta.") + tail;

describe("KP2: an epigraph right after a chapter title", () => {
  it("sets a quoted, italic quote with a name in capitals apart from the story", async () => {
    const r = await convert(chapter(fmt("“Deti nuk pyet kurrë se kush je.”", { italic: true }) + fmt("BESNIK PROVA")));
    expect(epigraphs(r)).toEqual([expect.objectContaining({ applied: true, confidence: "high" })]);
    const html = firstChapter(r);
    expect(classes(html)).toEqual(["epigraph", "epigraph-source", "", ""]);
    expect(html).toContain('<p class="epigraph-source">BESNIK PROVA</p>');
  });

  it("needs no italics: a quote in quotation marks and a name after a dash", async () => {
    const r = await convert(chapter(fmt("“Era di gjithçka, por nuk tregon asgjë.”") + fmt("— Besnik Prova")));
    expect(epigraphs(r)[0]).toMatchObject({ applied: true, confidence: "high" });
    expect(classes(firstChapter(r))).toEqual(["epigraph", "epigraph-source", "", ""]);
  });

  it("needs no quotation marks: an italic quote over two paragraphs and Name – “Work”", async () => {
    const r = await convert(
      chapter(
        fmt("Ishim të rinj dhe deti ishte i vjetër.", { italic: true }) +
          fmt("Ai mbeti, ne ikëm.", { italic: true }) +
          fmt("Mira Prova – “Netë të gjata”"),
      ),
    );
    expect(epigraphs(r)[0]).toMatchObject({ applied: true, confidence: "high" });
    expect(classes(firstChapter(r))).toEqual(["epigraph", "epigraph", "epigraph-source", "", ""]);
  });

  it("only offers an unclear one (one sign besides the name), and the author can confirm it", async () => {
    const opening = fmt("Ishim të rinj dhe deti ishte i vjetër.") + fmt("Mira Prova – “Netë të gjata”");
    const r = await convert(chapter(opening));
    const [g] = epigraphs(r);
    expect(g).toMatchObject({ applied: false, confidence: "medium" });
    expect(classes(firstChapter(r))).toEqual(["", "", "", ""]);
    // Flagged for the author in the health box and the list.
    expect(healthReport(r.cleanup).some((l) => l.tone === "check" && l.text.includes("Kontrolloni këto"))).toBe(true);
    expect(describeGuess(g, false, true)).toMatchObject({ action: "Formatoje si moto", unsure: true });
    // Confirm in the preview -> applied on the rebuild.
    const applied = emptyChoices();
    expect(canToggleGuess(g, applied)).toBe(true);
    const choices = toggleGuess(g, applied, applied);
    expect(choices.makeEpigraph).toEqual([g.paragraph]);
    const again = await convert(chapter(opening), choices);
    expect(epigraphs(again)[0]).toMatchObject({ applied: true });
    expect(classes(firstChapter(again))).toEqual(["epigraph", "epigraph-source", "", ""]);
    // And back again (the rebuild was made with these choices).
    expect(toggleGuess(epigraphs(again)[0], choices, choices)).toMatchObject({ makeEpigraph: [], notEpigraph: [g.paragraph] });
  });

  it("can be turned back into normal text by the author (notEpigraph)", async () => {
    const xml = chapter(fmt("“Deti nuk pyet kurrë.”", { italic: true }) + fmt("BESNIK PROVA"));
    const r = await convert(xml);
    const [g] = epigraphs(r);
    const choices = toggleGuess(g, emptyChoices(), emptyChoices());
    expect(choices.notEpigraph).toEqual([g.paragraph]);
    expect(normalizeChoices(JSON.parse(JSON.stringify(choices)))).toEqual(choices);
    const back = await convert(xml, choices);
    expect(epigraphs(back)[0]).toMatchObject({ applied: false });
    expect(classes(firstChapter(back))).toEqual(["", "", "", ""]);
  });

  it("keeps a right-aligned name line as the epigraph's name line", async () => {
    const r = await convert(chapter(fmt("Deti nuk pyet.", { italic: true }) + fmt("— Besnik Prova", { align: "right" })));
    expect(epigraphs(r)[0]).toMatchObject({ applied: true, signs: expect.arrayContaining(["name aligned right"]) });
    expect(classes(firstChapter(r))).toEqual(["epigraph", "epigraph-source", "", ""]);
  });

  it("takes two epigraphs in a row", async () => {
    const r = await convert(
      chapter(fmt("“Deti nuk pyet.”", { italic: true }) + fmt("BESNIK PROVA") + fmt("“Era nuk pret.”", { italic: true }) + fmt("EMA PROVA")),
    );
    expect(epigraphs(r).map((g) => g.applied)).toEqual([true, true]);
    expect(classes(firstChapter(r))).toEqual(["epigraph", "epigraph-source", "epigraph", "epigraph-source", "", ""]);
  });
});

describe("KP2: what is never an epigraph", () => {
  it("a dialogue opening (lines starting with a dash)", async () => {
    const r = await convert(chapter(fmt("— Po vij, tha ai.") + fmt("— Mirë") + fmt("— Ku je?")));
    expect(epigraphs(r)).toEqual([]);
  });

  it("a name after a dash followed by dialogue is only offered", async () => {
    const r = await convert(chapter(fmt("Ku je, more?", { italic: true }) + fmt("— Ana") + fmt("— Këtu jam, tha ajo.")));
    expect(epigraphs(r)[0]).toMatchObject({ applied: false, confidence: "medium" });
  });

  it("an epigraph with no name line (not covered: it reads as the first paragraph)", async () => {
    const r = await convert(chapter(fmt("“Deti nuk pyet kurrë se kush je.”", { italic: true })));
    expect(epigraphs(r)).toEqual([]);
  });

  it("a short sentence under the first paragraph", async () => {
    for (const line of ["Kështu foli Besniku.", "Pse?", "Ai erdhi, ajo iku,"]) {
      const r = await convert(chapter(fmt("“Deti nuk pyet.”", { italic: true }) + fmt(line)));
      expect(epigraphs(r)).toEqual([]);
    }
  });

  it("a long first paragraph, or a quote with nothing after it but the next chapter", async () => {
    const long = fmt(`“${LONG} ${LONG} ${LONG} ${LONG} ${LONG}”`, { italic: true });
    expect(epigraphs(await convert(chapter(long + fmt("BESNIK PROVA"))))).toEqual([]);
    const alone = story("DETI") + fmt("“Deti nuk pyet.”", { italic: true }) + fmt("BESNIK PROVA") + tail;
    expect(epigraphs(await convert(alone))).toEqual([]);
  });

  it("a one-word line in capitals is not a name sign (audit N1)", async () => {
    for (const word of ["BUM", "KËTU"]) {
      const r = await convert(chapter(fmt("Dëgjo.", { italic: true }) + fmt(word)));
      for (const g of epigraphs(r)) expect(g).toMatchObject({ applied: false, signs: expect.not.arrayContaining(["name in capitals"]) });
      expect(classes(firstChapter(r))).toEqual(["", "", "", ""]);
    }
  });

  it("a left-aligned page in big letters is a title page, not an epigraph page (audit N2)", async () => {
    const page = fmt("NJË DET PA BREG", { size: 40 }) + fmt("Mira Prova – “Tregime”");
    const r = await convert(fmt("Nënës sime.", { align: "center", italic: true }) + PAGE_BREAK + page + PAGE_BREAK + chapter(""));
    expect(epigraphs(r)).toEqual([]);
  });

  it("a centered epigraph stays as the author centered it", async () => {
    const r = await convert(chapter(fmt("Deti nuk pyet.", { italic: true, align: "center" }) + fmt("— Besnik Prova", { align: "center" })));
    expect(epigraphs(r)).toEqual([]);
    expect(classes(firstChapter(r)).slice(0, 2)).toEqual(["center", "center"]);
  });

  it("a short plain first line with a place name under it is at most offered", async () => {
    const r = await convert(chapter(fmt("Ishte natë.") + fmt("Tirana")));
    for (const g of epigraphs(r)) expect(g.applied).toBe(false);
    expect(classes(firstChapter(r))).toEqual(["", "", "", ""]);
  });
});

describe("KP2: an epigraph page before the first chapter", () => {
  const front = (page: string) => fmt("Nënës sime.", { align: "center", italic: true }) + PAGE_BREAK + page + PAGE_BREAK + chapter("");

  it("is set as epigraphs when the page holds nothing else", async () => {
    const r = await convert(
      front(fmt("Ishim të rinj dhe deti ishte i vjetër.", { italic: true }) + fmt("Mira Prova – “Netë të gjata”")),
    );
    expect(epigraphs(r)[0]).toMatchObject({ applied: true });
    expect(r.sections.map((s) => s.heading)).toEqual([null, null, "DETI", "GURI"]);
    // (A blank line kept after the centered page before it is older behaviour, not KP2's.)
    expect(classes(r.sections[1].html).filter((c) => c !== "gap")).toEqual(["epigraph", "epigraph-source"]);
  });

  it("is left alone when other text shares the page (a foreword signed with a name)", async () => {
    const r = await convert(
      front(fmt("Ishim të rinj dhe deti ishte i vjetër.", { italic: true }) + fmt("MIRA PROVA") + body("Parathënie.")),
    );
    expect(epigraphs(r)).toEqual([]);
  });
});

describe("KP2: in the ebook and the author preview", () => {
  const xml = chapter(fmt("“Deti nuk pyet kurrë se kush je.”", { italic: true }) + fmt("BESNIK PROVA"));

  it("styles the block: no indent, name set apart, gap after, first story paragraph not indented", async () => {
    const r = await convert(xml);
    const bytes = await generateEpub({
      bookId: "11111111-1111-1111-1111-111111111111",
      title: "Libri i detit",
      authorName: "Autor Prove",
      sections: r.sections,
      images: [],
    });
    const css = await (await JSZip.loadAsync(bytes)).file("OEBPS/styles.css")!.async("string");
    expect(css).toContain("p.epigraph { text-indent: 0;");
    expect(css).toMatch(/p\.epigraph-source \{ text-indent: 0; text-align: right; margin: [^}]*1\.8em/);
    expect(css).toMatch(/p\.epigraph-source \+ p[,\s][^{]*\{ text-indent: 0; \}/);
    expect(await validateEpubStructure(bytes)).toMatchObject({ valid: true });
  });

  it("keeps the classes through the preview's sanitizer", async () => {
    const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml: xml, includeStyles: true }), {}, { preview: true });
    if (!result.success) throw new Error("conversion failed");
    const html = result.preview!.find((s) => s.heading === "DETI")!.html;
    const found: string[] = [];
    const walk = (nodes: PreviewNode[]) => {
      for (const n of nodes) {
        if (typeof n === "string") continue;
        if (n.tag === "p" && n.attrs.class) found.push(n.attrs.class);
        walk(n.children);
      }
    };
    walk(parseChapterXhtml(`<html><body>${html}</body></html>`));
    expect(found).toEqual(["epigraph", "epigraph-source"]);
  });
});
