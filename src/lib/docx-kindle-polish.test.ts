import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import { convertDocxToDocument } from "./docx-converter";
import { buildDocxBytes, emptyPara, fmt } from "./docx-test-fixtures";
import { canToggleGuess, emptyChoices, normalizeChoices, toggleGuess } from "./docx-preview-choices";
import { generateEpub } from "./epub-generator";
import { countEpubWords, extractEpubSample } from "./epub-sample";
import { validateEpubStructure } from "./epub-validation";
import { addLibrumPages, frontPageXhtml, type LibrumFrontPage } from "./epub-librum-pages";

// "Kindle polish" (Renato's Kindle test, 7 Nov 2026; his picks: contents
// page a, title page a). A look-alike of a real book's front matter:
// every word, name and address here is invented.

const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
const LONG = "Ajo ishte një ditë e zakonshme në qytet, me njerëz që shkonin në punë dhe fëmijë që vraponin drejt shkollës.";
const body = (seed: string) => fmt(`${seed} ${LONG}`, { pageBreakBefore: true }); // Word's "page break before" noise
const story = (title: string) => fmt(title, { style: "Heading1", size: 28, align: "center" });

const TITLE_PAGE =
  emptyPara(3) +
  fmt("LIBRI I DETIT", { align: "center", size: 32 }) +
  fmt("Tregime", { align: "center", size: 32 }) +
  fmt("Autor Prove", { align: "center" }) +
  fmt("(BOTIM I RISHIKUAR 2020)", { align: "center" }) +
  fmt("© 2010 Autor Prove. Të gjitha të drejtat e rezervuara.", { align: "center" }) +
  fmt("Shtëpia Botuese Prova", { align: "center" }) +
  fmt(
    "Ndalohet riprodhimi i këtij libri pa lejen me shkrim të autorit, në çdo formë dhe me çdo mjet, elektronik ose mekanik, përfshirë fotokopjimin.",
    { align: "center" },
  ) +
  PAGE_BREAK;
const DEDICATION =
  fmt("Nënës sime,", { align: "center", italic: true }) +
  fmt("që më mësoi", { align: "center", italic: true }) +
  fmt("të dëgjoj detin.", { align: "center", italic: true }) +
  PAGE_BREAK;
const FOREWORD = fmt(`Parathënie e shkurtër. ${LONG} ${LONG}`) + PAGE_BREAK;
const EPIGRAPHS =
  fmt("Deti nuk pyet kurrë.", { align: "center", italic: true }) +
  fmt("— Naim Prova", { align: "center" }) +
  fmt("Era di gjithçka.", { align: "center", italic: true }) +
  fmt("— Ema Prova", { align: "center" }) +
  PAGE_BREAK;
const STORIES = story("LIBRI I DETIT") + body("E hëna.") + body("E marta.") + story("GURI") + body("E mërkura.") + body("E enjtja.");
const BOOK = TITLE_PAGE + DEDICATION + FOREWORD + EPIGRAPHS + STORIES;

async function convert(options = {}, bodyXml = BOOK) {
  const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml, includeStyles: true }), options);
  if (!result.success) throw new Error(`conversion failed: ${result.error}`);
  return result;
}
const text = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const titleGuesses = (r: Awaited<ReturnType<typeof convert>>) => r.cleanup.guesses.filter((g) => g.kind === "title_page");

describe("K1a: Word page breaks before the first chapter become pages", () => {
  it("puts the title page, dedication, foreword and epigraphs on pages of their own", async () => {
    const r = await convert({ bookTitle: "Libri i detit" });
    expect(r.sections.map((s) => s.heading)).toEqual([null, null, null, null, "LIBRI I DETIT", "GURI"]);
    const pages = r.sections.slice(0, 4).map((s) => text(s.html));
    expect(pages[0]).toContain("Autor Prove");
    expect(pages[0]).toContain("(BOTIM I RISHIKUAR 2020)");
    expect(pages[1]).toBe("Nënës sime, që më mësoi të dëgjoj detin.");
    expect(pages[2].startsWith("Parathënie e shkurtër.")).toBe(true);
    expect(pages[3]).toBe("Deti nuk pyet kurrë. — Naim Prova Era di gjithçka. — Ema Prova");
    // The marker paragraph never reaches the book.
    expect(r.sections.map((s) => s.html).join("")).not.toContain("librum-page-break");
  });

  it("ignores Word's 'page break before' setting: the stories stay one part each", async () => {
    const r = await convert();
    const stories = r.sections.filter((s) => s.heading);
    expect(stories.map((s) => (s.html.match(/<p/g) ?? []).length)).toEqual([2, 2]);
  });

  it("ignores 'page break before' on front-matter lines too: only typed breaks start a page", async () => {
    const noisy = (t: string) => fmt(t, { align: "center", italic: true, pageBreakBefore: true });
    const bodyXml = noisy("Nënës sime,") + noisy("që më mësoi") + PAGE_BREAK + noisy("Deti nuk pyet kurrë.") + noisy("— Naim Prova") + STORIES;
    const r = await convert({}, bodyXml);
    expect(r.sections.map((s) => s.heading)).toEqual([null, null, "LIBRI I DETIT", "GURI"]);
    expect(text(r.sections[0].html)).toBe("Nënës sime, që më mësoi");
  });

  it("keeps a page whose only line was the removed title as no page at all", async () => {
    const bodyXml = fmt("LIBRI I DETIT", { align: "center", size: 40 }) + PAGE_BREAK + DEDICATION + STORIES;
    const r = await convert({ bookTitle: "Libri i Detit" }, bodyXml);
    expect(r.sections.map((s) => s.heading)).toEqual([null, "LIBRI I DETIT", "GURI"]);
    expect(text(r.sections[0].html)).toBe("Nënës sime, që më mësoi të dëgjoj detin.");
  });

  it("keeps a page whose first line is removed as its own page (the page mark comes before the removal; audit N1)", async () => {
    const bodyXml =
      DEDICATION +
      fmt("© 2010 Autor Prove. Të gjitha të drejtat e rezervuara.", { align: "center" }) +
      fmt("Një fjalë e shkurtër për lexuesin", { align: "center", italic: true }) +
      PAGE_BREAK +
      STORIES;
    const r = await convert({}, bodyXml);
    expect(r.sections.map((s) => s.heading)).toEqual([null, null, "LIBRI I DETIT", "GURI"]);
    expect(text(r.sections[0].html)).toBe("Nënës sime, që më mësoi të dëgjoj detin.");
    expect(text(r.sections[1].html)).toBe("Një fjalë e shkurtër për lexuesin");
  });

  it("leaves a front part with more page breaks than a front part has as one part", async () => {
    const lines = Array.from({ length: 22 }, (_, i) => fmt(`Rreshti ${i + 1}`, { align: "center" }) + PAGE_BREAK).join("");
    const r = await convert({}, lines + STORIES);
    expect(r.sections.map((s) => s.heading)).toEqual([null, "LIBRI I DETIT", "GURI"]);
  });

  it("splits nothing in a book without chapters", async () => {
    const r = await convert({}, fmt("Pjesa e parë e tregimit. " + LONG) + PAGE_BREAK + fmt("Pjesa e dytë e tregimit. " + LONG));
    expect(r.sections).toHaveLength(1);
  });

  it("splits the author preview at the same places", async () => {
    const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml: BOOK, includeStyles: true }), {}, { preview: true });
    if (!result.success) throw new Error("conversion failed");
    expect(result.preview!.map((s) => s.heading)).toEqual(result.sections.map((s) => s.heading));
  });
});

describe("K1b + K1c: the typed title page", () => {
  it("K1b: is found although an old licence paragraph sits on the same page", async () => {
    const r = await convert();
    expect(titleGuesses(r).length).toBeGreaterThan(0);
    const all = r.sections.map((s) => text(s.html)).join(" ");
    expect(all).not.toContain("Ndalohet riprodhimi");
    expect(all).not.toContain("© 2010");
  });

  it("K1c: removes the line that is the book's title by default (case, ë and punctuation ignored)", async () => {
    for (const bookTitle of ["Libri i detit", "LIBRI I DETIT", "Libri i Detit."]) {
      const r = await convert({ bookTitle });
      const [own, other] = titleGuesses(r);
      expect(own).toMatchObject({ text: "LIBRI I DETIT", applied: true });
      // Another big line on the page is only offered, never removed by default.
      expect(other).toMatchObject({ text: "Tregime", applied: false });
      expect(text(r.sections[0].html)).not.toContain("LIBRI I DETIT");
      expect(text(r.sections[0].html)).toContain("Tregime");
    }
    const accentless = await convert({ bookTitle: "Deti i Përgjumur" }, BOOK.replace("LIBRI I DETIT", "DETI I PERGJUMUR"));
    expect(titleGuesses(accentless)[0].applied).toBe(true);
  });

  it("K1c: a big line that only contains the title is not the title (equal, not contains; audit N1)", async () => {
    const r = await convert({ bookTitle: "Deti" }, BOOK.replace("LIBRI I DETIT", "DETI NUK PYET"));
    expect(titleGuesses(r).every((g) => !g.applied)).toBe(true);
    expect(titleGuesses(r)[0].text).toContain("DETI NUK PYET");
    expect(text(r.sections[0].html)).toContain("DETI NUK PYET");
  });

  it("K1c: a two-line title read together is the book's title", async () => {
    const bodyXml =
      fmt("NJË DET", { align: "center", size: 40 }) + fmt("PA BREG", { align: "center", size: 40 }) + PAGE_BREAK + STORIES;
    const r = await convert({ bookTitle: "Një det pa breg" }, bodyXml);
    expect(titleGuesses(r)).toEqual([expect.objectContaining({ text: "NJË DET / PA BREG", applied: true })]);
  });

  it("K1c: with no title, or another title, nothing on page 1 goes by default (audit r4 stays true)", async () => {
    for (const bookTitle of [undefined, "", "Një libër tjetër"]) {
      const r = await convert(bookTitle === undefined ? {} : { bookTitle });
      expect(titleGuesses(r).every((g) => !g.applied)).toBe(true);
      expect(text(r.sections[0].html)).toContain("LIBRI I DETIT");
    }
    // A big dedication alone on page 1 is not the title.
    const r = await convert({ bookTitle: "Libri i detit" }, fmt("Nënës sime", { align: "center", size: 40 }) + PAGE_BREAK + STORIES);
    expect(text(r.sections[0].html)).toBe("Nënës sime");
  });

  it("K1c: the author can keep the removed title, and remove an offered line", async () => {
    const first = await convert({ bookTitle: "Libri i detit" });
    const [own, other] = titleGuesses(first);
    const applied = emptyChoices();
    expect(canToggleGuess(own, applied)).toBe(true);
    const keep = toggleGuess(own, applied, applied);
    expect(keep.keepTitlePage).toEqual([own.paragraph]);
    const kept = await convert({ ...keep, bookTitle: "Libri i detit" });
    expect(titleGuesses(kept)[0]).toMatchObject({ applied: false, signs: expect.arrayContaining(["kept by the author"]) });
    expect(text(kept.sections[0].html)).toContain("LIBRI I DETIT");
    const remove = toggleGuess(other, applied, applied);
    expect(remove.removeTitlePage).toEqual([other.paragraph]);
    const removed = await convert({ ...remove, bookTitle: "Libri i detit" });
    expect(text(removed.sections[0].html)).not.toContain("Tregime");
    expect(normalizeChoices({ keepTitlePage: [4, 4, 2] })).toMatchObject({ keepTitlePage: [2, 4] });
  });
});

describe("K4: the contents page and landmarks", () => {
  const input = (sections: { heading: string | null; html: string }[]) => ({
    bookId: "11111111-1111-1111-1111-111111111111",
    title: "Libri i detit",
    authorName: "Autor Prove",
    sections,
    images: [],
  });
  const files = async (bytes: Buffer) => {
    const zip = await JSZip.loadAsync(bytes);
    return {
      opf: await zip.file("OEBPS/content.opf")!.async("string"),
      nav: await zip.file("OEBPS/nav.xhtml")!.async("string"),
    };
  };
  const spineOf = (opf: string) => [...opf.matchAll(/<itemref idref="([^"]+)"\/>/g)].map((m) => m[1]);

  it("is the first page of the book, styled, with every titled chapter tappable", async () => {
    const r = await convert({ bookTitle: "Libri i detit" });
    const bytes = await generateEpub(input(r.sections));
    const { opf, nav } = await files(bytes);
    expect(spineOf(opf)).toEqual(["nav", "chapter1", "chapter2", "chapter3", "chapter4", "chapter5", "chapter6"]);
    expect(nav).toContain('<link rel="stylesheet" type="text/css" href="styles.css"/>');
    expect(nav).toContain('<li><a href="chapter-5.xhtml">LIBRI I DETIT</a></li>');
    expect(nav).toContain('<li><a href="chapter-6.xhtml">GURI</a></li>');
    // Landmarks, hidden: the contents, and the text starting at the first titled chapter.
    expect(nav).toContain('<nav epub:type="landmarks" id="landmarks" hidden="">');
    expect(nav).toContain('<a epub:type="toc" href="nav.xhtml#toc">Përmbajtja</a>');
    expect(nav).toContain('<a epub:type="bodymatter" href="chapter-5.xhtml">');
    expect(await validateEpubStructure(bytes)).toMatchObject({ valid: true });
  });

  it("starts the text at the first part when no chapter has a title, also with endnotes", async () => {
    const one = await files(await generateEpub(input([{ heading: null, html: "<p>Tekst.</p>" }])));
    expect(one.nav).toContain('<a epub:type="bodymatter" href="chapter-1.xhtml">');
    const notes = await files(
      await generateEpub(input([{ heading: null, html: "<p>Tekst.</p>" }, { heading: "Shënime", html: "<p>Shënim.</p>" }])),
    );
    expect(notes.nav).toContain('<a epub:type="bodymatter" href="chapter-1.xhtml">');
  });

  it("is not counted in the reader sample or the page estimate", async () => {
    const sections = [
      { heading: "Kreu i parë", html: `<p>${LONG}</p>` },
      { heading: "Kreu i dytë", html: `<p>${LONG}</p>` },
    ];
    const bytes = await generateEpub(input(sections));
    const sample = await extractEpubSample(bytes);
    expect(sample.available).toBe(true);
    if (sample.available) expect(sample.sections.map((s) => s.html).join("")).not.toContain("Përmbajtja");
    // Two titles plus two paragraphs: the contents page adds nothing.
    const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
    expect(await countEpubWords(bytes)).toBe(words(`Kreu i parë Kreu i dytë ${LONG} ${LONG}`));
  });

  it("sits right after Librum's © page at download", async () => {
    const bytes = await generateEpub(input([{ heading: "Kreu i parë", html: "<p>Tekst.</p>" }]));
    const front: LibrumFrontPage = {
      title: "Libri i detit", subtitle: null, penName: "Autor Prove", originalAuthor: null, copyrightYear: 2026,
      originalYear: null, translators: [], rights: "own_rights", librumYear: 2026,
      isbn: null, publisher: null, edition: null, buyer: null,
    };
    const out = await addLibrumPages(bytes, { front, last: { penName: "Autor Prove", books: [], reviewUrl: "https://librum.al/libra/x" } });
    expect(out.added).toBe(true);
    expect(spineOf((await files(out.bytes)).opf)).toEqual(["librum-front", "nav", "chapter1", "librum-end"]);
  });
});

describe("K3: Librum's © page is tighter", () => {
  it("has smaller gaps than before (one Kindle screen)", () => {
    const page = frontPageXhtml({
      title: "Libri i detit", subtitle: null, penName: "Autor Prove", originalAuthor: null, copyrightYear: 2026,
      originalYear: null, translators: [], rights: "own_rights", librumYear: 2026,
      isbn: null, publisher: null, edition: null, buyer: null,
    });
    expect(page).toContain("h1{font-size:1.5em;margin:1em 0 .3em;font-weight:bold}");
    expect(page).toContain(".author{margin:.5em 0 1.2em;font-size:1.15em}");
    expect(page).toContain(".gap{margin-top:1em}");
    expect(page).not.toMatch(/2\.5em|1\.8em/);
  });
});
