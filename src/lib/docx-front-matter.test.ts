import { describe, expect, it } from "vitest";
import { convertDocxToDocument } from "./docx-converter";
import { buildDocxBytes, emptyPara, fmt, heading, prose } from "./docx-test-fixtures";
import { canToggleGuess, describeGuess, emptyChoices, toggleGuess } from "./docx-preview-choices";

// BD3 patch 2 (Renato 1 Nov: 2a, 3a; 1a 2a 3a): the author's own
// copyright page and typed title page go from Word books (Librum adds
// its own page at download); a wrong removal can be undone in the
// preview; other stores and contact details are warned about. All text
// is invented; the shapes copy Smashwords-style and Albanian front pages.

async function convert(bodyXml: string, options = {}, includeStyles = false) {
  const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml, includeStyles }), options);
  if (!result.success) throw new Error(`conversion failed: ${result.error}`);
  return result;
}

// A typed title page is only OFFERED for removal (Renato 1 Nov, after
// audit r4): by default nothing on it goes. This converts once, checks
// the default kept the title, then converts again with the author's
// "remove" on the offered title (removeTitlePage).
async function withTitleRemoved(bodyXml: string, includeStyles = false) {
  const first = await convert(bodyXml, {}, includeStyles);
  const offer = first.cleanup.guesses.find((g) => g.kind === "title_page");
  if (!offer) throw new Error("no title page offered");
  expect(offer.applied).toBe(false);
  expect(allText(first)).toContain(offer.text.split(" / ")[0]);
  return convert(bodyXml, { removeTitlePage: [offer.paragraph] }, includeStyles);
}

const chapter = (text: string, breakBefore = true) => fmt(text, { align: "center", size: 36, pageBreakBefore: breakBefore });
const allText = (r: Awaited<ReturnType<typeof convert>>) => r.sections.map((s) => `${s.heading ?? ""} ${s.html}`).join("\n");
const guessOf = (r: Awaited<ReturnType<typeof convert>>, kind: string) => r.cleanup.guesses.filter((g) => g.kind === kind);

const ALBANIAN_COPYRIGHT_PAGE =
  fmt("© 2020 Autor Prove", { align: "center" }) +
  fmt("Të gjitha të drejtat e rezervuara.", { align: "center" }) +
  emptyPara() +
  fmt("Botuar nga Shtëpia Botuese Prova, Tiranë", { align: "center" }) +
  fmt("ISBN 978-9928-00-000-0", { align: "center" }) +
  fmt("Kopertina: Artist Prove", { align: "center", pageBreakAfter: true });

const BODY = chapter("Kapitulli 1") + prose("Dita") + prose("Nata") + chapter("Kapitulli 2") + prose("Era");

describe("BD3 patch 2: the author's copyright page", () => {
  it("removes a whole Albanian copyright page before the first chapter", async () => {
    const r = await convert(ALBANIAN_COPYRIGHT_PAGE + BODY);
    expect(r.sections.map((s) => s.heading)).toEqual(["Kapitulli 1", "Kapitulli 2"]);
    const text = allText(r);
    for (const gone of ["2020 Autor Prove", "drejtat e rezervuara", "Shtëpia Botuese", "ISBN", "Kopertina"]) {
      expect(text).not.toContain(gone);
    }
    expect(text).toContain("Dita ishte");
    const [g] = guessOf(r, "copyright_page");
    expect(g).toMatchObject({ applied: true, confidence: "high" });
    expect(g.text.startsWith("© 2020 Autor Prove / Të gjitha")).toBe(true);
    expect(r.cleanup.fixes.frontLinesRemoved).toBe(5);
  });

  it("brings the page back when the author says it is not a copyright page (1a)", async () => {
    const first = await convert(ALBANIAN_COPYRIGHT_PAGE + BODY);
    const [g] = guessOf(first, "copyright_page");
    const kept = await convert(ALBANIAN_COPYRIGHT_PAGE + BODY, { keepCopyright: [g.paragraph] });
    expect(allText(kept)).toContain("Të gjitha të drejtat e rezervuara.");
    expect(guessOf(kept, "copyright_page")[0]).toMatchObject({ applied: false, paragraph: g.paragraph });
    expect(kept.cleanup.fixes.frontLinesRemoved).toBe(0);
  });

  it("on a title + copyright page, removes the title line and the copyright lines, keeps a dedication and an epigraph", async () => {
    const page =
      fmt("LIBRI I DETIT", { align: "center", size: 44 }) +
      fmt("Autor Prove", { align: "center", size: 30 }) +
      emptyPara(3) +
      fmt("Kushtuar nënës sime", { align: "center" }) +
      fmt("Deti nuk pyet kurrë se kush je.", { align: "center", italic: true }) +
      emptyPara(2) +
      fmt("Copyright © 2015 Autor Prove", { align: "center" }) +
      fmt("Smashwords Edition", { align: "center", pageBreakAfter: true });
    const r = await withTitleRemoved(page + BODY);
    const text = allText(r);
    expect(text).not.toContain("LIBRI I DETIT");
    // Only the title line goes from a title page (audit r2): the
    // smaller author line stays.
    expect(text).toContain("Autor Prove");
    expect(text).not.toContain("Copyright");
    expect(text).not.toContain("Smashwords Edition");
    expect(text).toContain("Kushtuar nënës sime");
    expect(text).toContain("Deti nuk pyet kurrë");
  });

  it("with no page break and no chapters, removes only the copyright lines and their store/edition lines (3a)", async () => {
    const r = await convert(
      fmt("Tregimi i Detit", { align: "center", size: 40 }) +
        fmt("nga Autor Prove", { align: "center" }) +
        fmt("Copyright 2015 Autor Prove") +
        fmt("Smashwords Edition") +
        fmt(
          "License Notes: This ebook is licensed for your personal enjoyment only. This ebook may not be re-sold or given away to other people. Thank you for respecting the hard work of this author.",
        ) +
        prose("Dita") +
        prose("Nata"),
    );
    const text = allText(r);
    expect(text).toContain("Tregimi i Detit");
    expect(text).toContain("nga Autor Prove");
    expect(text).not.toContain("Copyright 2015");
    expect(text).not.toContain("Smashwords Edition");
    expect(text).not.toContain("License Notes");
    expect(text).toContain("Dita ishte");
    // The big first line becomes the story's title (its one chapter);
    // the copyright lines under it go line by line.
    expect(guessOf(r, "copyright_page")[0]).toMatchObject({ applied: true, signs: ["copyright lines under the book's title"] });
  });

  it("with no chapters at all, takes the copyright lines before the story and stops where the story starts", async () => {
    const r = await convert(
      fmt("Tregimi i Detit") +
        fmt("nga Autor Prove") +
        fmt("© 2015 Autor Prove. All rights reserved.") +
        fmt("www.autorprove.example") +
        fmt("— Ku je? — pyeti ajo.") +
        fmt("Të gjitha të drejtat e rezervuara, tha ai duke qeshur.") +
        prose("Dita"),
    );
    const text = allText(r);
    expect(r.cleanup.chapters).toBe(0);
    expect(text).not.toContain("© 2015");
    expect(text).not.toContain("www.autorprove.example");
    expect(text).toContain("Tregimi i Detit");
    // The story started at the dialogue line: a copyright phrase inside
    // the story is never touched.
    expect(text).toContain("Të gjitha të drejtat e rezervuara, tha ai duke qeshur.");
    expect(guessOf(r, "copyright_page")).toHaveLength(1);
  });

  it("never removes a long paragraph or anything after the first chapter", async () => {
    const longCopyrightProse = `Parathënie: ${"fjalë ".repeat(130)}dhe copyright i kësaj vepre është i autorit.`;
    const r = await convert(
      fmt(longCopyrightProse, { pageBreakAfter: true }) +
        chapter("Kapitulli 1") +
        prose("Dita") +
        fmt("© 2020 Autor Prove") +
        fmt("Të gjitha të drejtat e rezervuara.") +
        prose("Nata"),
    );
    const text = allText(r);
    expect(text).toContain("copyright i kësaj vepre");
    expect(text).toContain("© 2020 Autor Prove");
    expect(guessOf(r, "copyright_page")).toEqual([]);
  });

  it("leaves a book with no copyright words alone", async () => {
    const r = await convert(fmt("Një shënim i shkurtër i autorit.", { pageBreakAfter: true }) + BODY);
    expect(allText(r)).toContain("Një shënim i shkurtër i autorit.");
    expect(guessOf(r, "copyright_page")).toEqual([]);
    expect(r.cleanup.fixes.frontLinesRemoved).toBe(0);
  });
});

describe("BD3 patch 2: the typed title page (2a)", () => {
  it("is not taken for a centered poem in normal size", async () => {
    const r = await convert(
      fmt("Deti fle", { align: "center" }) + fmt("hëna rri zgjuar", { align: "center" }) + fmt("dhe unë pres", { align: "center", pageBreakAfter: true }) + BODY,
    );
    expect(allText(r)).toContain("hëna rri zgjuar");
    expect(guessOf(r, "title_page")).toEqual([]);
  });

  it("removes nothing when a chapter and prose share the first page (not a page of its own)", async () => {
    const r = await convert(fmt("LIBRI I DETIT", { align: "center", size: 44 }) + chapter("Kapitulli 1", false) + prose("Dita") + chapter("Kapitulli 2") + prose("Era"));
    const text = allText(r);
    expect(text).toContain("LIBRI I DETIT");
    expect(text).toContain("Kapitulli 1");
    expect(text).toContain("Dita ishte");
  });
});

describe("BD3 patch 2: other stores and contact details (3a)", () => {
  it("warns about another store named in a chapter, without changing the text", async () => {
    const r = await convert(BODY + fmt("Librat e mi i gjeni edhe në Amazon dhe Smashwords."));
    const w = r.warnings.find((x) => x.code === "other_store_mentioned");
    expect(w?.message).toContain("(Amazon, Smashwords)");
    expect(allText(r)).toContain("Librat e mi i gjeni edhe në Amazon dhe Smashwords.");
  });

  it("warns about an email or a phone number, but not about Librum's own address", async () => {
    const r = await convert(BODY + fmt("Më shkruani: autor.prove@example.com ose +355 69 123 4567. Ndihmë: support@librum.al"));
    const w = r.warnings.find((x) => x.code === "contact_details_in_book");
    expect(w?.message).toContain("autor.prove@example.com");
    expect(w?.message).toContain("+355 69 123 4567");
    expect(w?.message).not.toContain("librum.al");
  });

  it("does not warn about a store that was only on the removed copyright page", async () => {
    const r = await convert(
      fmt("Copyright © 2015 Autor Prove", { align: "center" }) + fmt("Smashwords Edition", { align: "center", pageBreakAfter: true }) + BODY,
    );
    expect(r.warnings.filter((x) => x.code === "other_store_mentioned")).toEqual([]);
  });

  it("warns nothing for an ordinary book", async () => {
    const r = await convert(BODY);
    expect(r.warnings.filter((x) => x.code === "other_store_mentioned" || x.code === "contact_details_in_book")).toEqual([]);
  });
});

// Audit r1 (FAIL): each input that lost real text, kept as a test.
describe("BD3 patch 2: never loses the author's text (audit r1 H1-H6, M2)", () => {
  it("H1: a copyright phrase inside the first chapter stays", async () => {
    const r = await convert(
      chapter("Kapitulli 1") +
        fmt("Të gjitha të drejtat e tokës i kishte babai im, që nga viti 1990, por askush nuk i besonte.", { tabs: 1 }) +
        fmt("— Ku je?") +
        fmt("— Këtu!") +
        fmt("Avokati tha se copyright-i i këngës ishte i saj dhe askush nuk mund ta merrte.") +
        prose("Dita") +
        chapter("Kapitulli 2") +
        prose("Era"),
    );
    const text = allText(r);
    expect(text).toContain("Të gjitha të drejtat e tokës");
    expect(text).toContain("copyright-i i këngës");
    expect(guessOf(r, "copyright_page")).toEqual([]);
  });

  it("H1: a poem line starting with 'Copyright' stays, with and without Heading 2 styles", async () => {
    const body = heading(2, "Vjeshta") + fmt("Deti fle") + fmt("Copyright i zemrës sime je ti") + heading(2, "Dimri") + fmt("Bora bie");
    for (const includeStyles of [true, false]) {
      const result = await convertDocxToDocument(await buildDocxBytes({ bodyXml: body, includeStyles }));
      if (!result.success) throw new Error("conversion failed");
      expect(result.sections.map((x) => x.html).join("\n")).toContain("Copyright i zemrës sime je ti");
    }
  });

  it("H2: a book with no chapters keeps its first paragraph", async () => {
    const r = await convert(
      fmt("Të gjitha të drejtat e njeriut i kishte lexuar në shkollë, por askush nuk ia kishte mësuar si t'i mbronte.") + prose("Dita"),
    );
    expect(allText(r)).toContain("Të gjitha të drejtat e njeriut");
  });

  it("H3: story sentences next to a copyright line stay", async () => {
    const r = await convert(
      fmt("© 2020 Autor Prove") +
        fmt("Kindle-i i saj u fik në mesnatë.") +
        fmt("Ajo hapi faqen www.lajme.example dhe u tremb.") +
        fmt("Ndalohet çdo riprodhim pa leje.") +
        fmt("Botuesi e ktheu dorëshkrimin pa e lexuar.") +
        prose("Dita"),
    );
    const text = allText(r);
    expect(text).not.toContain("© 2020");
    // The story starts at the first sentence: nothing after it is touched.
    expect(text).toContain("Ndalohet çdo riprodhim pa leje.");
    expect(text).toContain("Kindle-i i saj u fik në mesnatë.");
    expect(text).toContain("www.lajme.example");
    expect(text).toContain("Botuesi e ktheu dorëshkrimin");
  });

  it("H4: on a copyright page, a plain dedication, an epigraph, an author's note and a list stay", async () => {
    const r = await convert(
      fmt("Nënës sime", { align: "center" }) +
        emptyPara(2) +
        fmt("Njeriu është ai që kujton.", { align: "center" }) +
        fmt("— Naim Prova", { align: "center" }) +
        fmt("Fjala e autorit") +
        fmt("Këtë libër e shkrova në dimër.") +
        fmt("Përmbajtja") +
        fmt("Byrek me spinaq\t12") +
        emptyPara(3) +
        fmt("© 2020 Autor Prove", { align: "center" }) +
        fmt("Të gjitha të drejtat e rezervuara.", { align: "center", pageBreakAfter: true }) +
        BODY,
    );
    const text = allText(r);
    for (const kept of ["Nënës sime", "Njeriu është ai që kujton.", "— Naim Prova", "Fjala e autorit", "Këtë libër e shkrova në dimër.", "Byrek me spinaq"]) {
      expect(text).toContain(kept);
    }
    expect(text).not.toContain("© 2020");
    expect(text).not.toContain("rezervuara");
  });

  it("H5: a dedication on the title page stays (Albanian dative, English 'For')", async () => {
    for (const dedication of ["Prindërve të mi", "For Anna"]) {
      const r = await withTitleRemoved(fmt("LIBRI I DETIT", { align: "center", size: 44 }) + fmt(dedication, { align: "center", pageBreakAfter: true }) + BODY);
      const text = allText(r);
      expect(text).not.toContain("LIBRI I DETIT");
      expect(text).toContain(dedication);
    }
  });

  it("H6: the first poem of a poem book is not a title page", async () => {
    const poem = (t: string, first = false) =>
      fmt(t, { align: "center", size: 32, pageBreakBefore: !first }) +
      fmt("deti fle", { align: "center" }) +
      fmt("hëna rri zgjuar", { align: "center" }) +
      fmt("dhe unë pres", { align: "center" });
    const r = await convert(poem("VJESHTA", true) + poem("DIMRI") + poem("PRANVERA") + poem("VERA"));
    expect(allText(r)).toContain("VJESHTA");
    expect(guessOf(r, "title_page")).toEqual([]);
  });

  it("M2: publisher lines ending in ë are recognised", async () => {
    const r = await convert(
      fmt("© 2020 Autor Prove", { align: "center" }) +
        fmt("Botuar në Tiranë", { align: "center" }) +
        fmt("Botim i parë", { align: "center" }) +
        fmt("Shtypur në Shqipëri", { align: "center", pageBreakAfter: true }) +
        BODY,
    );
    const text = allText(r);
    for (const gone of ["Botuar në Tiranë", "Botim i parë", "Shtypur në Shqipëri"]) expect(text).not.toContain(gone);
  });
});

// Audit r2 (FAIL): each input that lost real text, kept as a test.
describe("BD3 patch 2: title page takes only the title (audit r2)", () => {
  const T = (x: string) => fmt("LIBRI I DETIT", { align: "center", size: 48 }) + x;

  it("H1: a bigger dedication or epigraph line and a Subtitle-style line stay", async () => {
    const a = await withTitleRemoved(T(fmt("Nënës sime", { align: "center", size: 28, pageBreakAfter: true })) + BODY);
    expect(allText(a)).toContain("Nënës sime");
    expect(allText(a)).not.toContain("LIBRI I DETIT");
    const b = await convert(T(fmt("Njeriu është ai që kujton", { align: "center", size: 28 }) + fmt("x", { pageBreakAfter: true })) + BODY);
    expect(allText(b)).toContain("Njeriu është ai që kujton");
    const styled = await convertDocxToDocument(
      await buildDocxBytes({
        bodyXml: fmt("LIBRI", { style: "Title" }) + fmt("Nënës sime", { style: "Subtitle", pageBreakAfter: true }) + heading(1, "Kapitulli 1") + prose("Dita"),
        includeStyles: true,
      }),
    );
    if (!styled.success) throw new Error("conversion failed");
    const text = styled.sections.map((x) => `${x.heading ?? ""} ${x.html}`).join("\n");
    expect(text).toContain("Nënës sime");
  });

  it("H2 / M1: lines starting with 'Nga' or 'By', and dated dedications, stay", async () => {
    for (const line of ["Nga zemra, për nënën time", "Nga mali vjen era e ftohtë", "By the sea we were young", "Për Anën, 2019", "In memoriam 2019"]) {
      const r = await convert(T(fmt(line, { align: "center", pageBreakAfter: true })) + BODY);
      expect(allText(r)).toContain(line);
    }
  });

  it("M2: a prologue heading on a first page with prose is not a book title", async () => {
    const r = await convert(fmt("Nata e parë", { align: "center", size: 44 }) + prose("Hyrja") + fmt("Fundi i hyrjes.", { pageBreakAfter: true }) + BODY);
    expect(allText(r)).toContain("Nata e parë");
    expect(guessOf(r, "title_page")).toEqual([]);
  });

  it("M3: when the first chapter found comes late, the story before it is not front matter", async () => {
    const r = await convert(
      prose("A") +
        fmt("— Botuesi?") +
        fmt("All rights reserved, tha ai") +
        fmt("x", { pageBreakAfter: true }) +
        prose("B") +
        fmt("Epilogu", { align: "center", size: 36, pageBreakBefore: true }) +
        prose("C"),
    );
    const text = allText(r);
    expect(text).toContain("— Botuesi?");
    expect(text).toContain("All rights reserved, tha ai");
  });

  it("LOW: a dialogue line next to a copyright line stays", async () => {
    const r = await convert(fmt("— Botuesi?") + fmt("© 2020 Autor Prove") + prose("Dita"));
    // The story starts at the question: nothing is removed.
    expect(allText(r)).toContain("— Botuesi?");
    const r2 = await convert(fmt("© 2020 Autor Prove") + fmt("— Botuesi?") + prose("Dita"));
    expect(allText(r2)).toContain("— Botuesi?");
    expect(allText(r2)).not.toContain("© 2020");
  });
});

// Audit r3 (FAIL): each input that lost real text, kept as a test.
describe("BD3 patch 2: title line only, whatever the chapter size (audit r3)", () => {
  const ch = (t: string) => fmt(t, { align: "center", bold: true, pageBreakBefore: true });
  const BOLD_BODY = ch("Kapitulli 1") + prose("Dita") + ch("Kapitulli 2") + prose("Era") + ch("Kapitulli 3") + prose("Uji");

  it("H1: a bigger dedication stays when chapter titles are body size", async () => {
    const r = await withTitleRemoved(fmt("LIBRI I DETIT", { align: "center", size: 48 }) + fmt("Nënës sime", { align: "center", size: 28, pageBreakAfter: true }) + BOLD_BODY);
    expect(allText(r)).toContain("Nënës sime");
    expect(allText(r)).not.toContain("LIBRI I DETIT");
    expect(guessOf(r, "title_page")[0].text).toBe("LIBRI I DETIT");
  });

  it("H1: with a Title-style line, a bigger epigraph stays (Heading 1 chapters)", async () => {
    const result = await withTitleRemoved(
      fmt("LIBRI I DETIT", { style: "Title" }) +
        fmt("Njeriu është ai që kujton", { align: "center", size: 28, pageBreakAfter: true }) +
        heading(1, "Kapitulli 1") +
        prose("Dita") +
        heading(1, "Kapitulli 2") +
        prose("Era"),
      true,
    );
    const text = allText(result);
    expect(text).toContain("Njeriu është ai që kujton");
    expect(text).not.toContain("LIBRI I DETIT");
  });

  it("M1: a part heading or a big dedication alone on page 1 stays", async () => {
    for (const line of ["PART ONE", "PJESA E PARË: DETI", "Për nënën time"]) {
      const r = await convert(fmt(line, { align: "center", size: 48, pageBreakAfter: true }) + BODY);
      expect(allText(r)).toContain(line);
    }
  });
});

// Audit r4 (FAIL) led to Renato's call: a typed title page is offered,
// never removed by default. Every audit r4 input keeps its text.
describe("BD3 patch 2: nothing on page 1 is removed unless the author asks (audit r4)", () => {
  const ch = (t: string) => fmt(t, { align: "center", bold: true, pageBreakBefore: true });
  const BOLD_BODY = ch("Kapitulli 1") + prose("Dita") + ch("Kapitulli 2") + prose("Era") + ch("Kapitulli 3") + prose("Uji");
  const cases: [string, string][] = [
    [fmt("Prindërve të mi", { align: "center", size: 28, pageBreakAfter: true }) + BOLD_BODY, "Prindërve të mi"],
    [fmt("Dedicated to my mother", { align: "center", size: 40, pageBreakAfter: true }) + BODY, "Dedicated to my mother"],
    [fmt("Kujtimit të babait tim", { align: "center", size: 40, pageBreakAfter: true }) + BODY, "Kujtimit të babait tim"],
    [
      fmt("© 2020 Autor Prove", { align: "center" }) + emptyPara(3) + fmt("Deti nuk pyet kurrë", { align: "center", size: 28 }) + fmt("— Naim Prova", { align: "center", pageBreakAfter: true }) + BOLD_BODY,
      "Deti nuk pyet kurrë",
    ],
    [fmt("PROLOGU", { align: "center", size: 28 }) + fmt("Deti fle", { align: "center" }) + fmt("era ikën", { align: "center", pageBreakAfter: true }) + BOLD_BODY, "PROLOGU"],
    [fmt("LIBRI I DETIT", { align: "center", size: 40 }) + emptyPara(4) + fmt("Nënës sime", { align: "center", size: 40, pageBreakAfter: true }) + BODY, "Nënës sime"],
    [fmt("PJESA E PARË", { align: "center", size: 48 }) + fmt("DETI", { align: "center", size: 48, pageBreakAfter: true }) + BODY, "DETI"],
  ];
  it.each(cases.map(([body, line], i) => [i, body, line]))("case %i keeps its line by default", async (_i, body, line) => {
    const r = await convert(body as string);
    expect(allText(r)).toContain(line as string);
    expect(guessOf(r, "title_page").filter((g) => g.applied)).toEqual([]);
  });
});

describe("BD3 patch 2: audit r5", () => {
  it("M1: a removed title page can be brought back in the preview", async () => {
    const body = fmt("LIBRI I DETIT", { align: "center", size: 48 }) + fmt("Autor Prove", { align: "center", pageBreakAfter: true }) + BODY;
    const first = await convert(body);
    const offer = guessOf(first, "title_page")[0];
    const applied = emptyChoices();
    const chosen = toggleGuess(offer, applied, applied);
    expect(chosen.removeTitlePage).toEqual([offer.paragraph]);
    const removed = await convert(body, chosen);
    const done = guessOf(removed, "title_page")[0];
    expect(done.applied).toBe(true);
    expect(canToggleGuess(done, chosen)).toBe(true);
    expect(describeGuess(done, true, true).action).toBe("Ktheje në libër");
    const back = toggleGuess(done, chosen, chosen);
    expect(back.removeTitlePage).toEqual([]);
    expect(allText(await convert(body, back))).toContain("LIBRI I DETIT");
  });

  it("L1: a big, italic or Subtitle line naming a store or an edition is not a publisher line", async () => {
    const r = await convert(
      fmt("LIBRI I DETIT", { align: "center", size: 48 }) +
        fmt("Rrugëtim në Amazon", { align: "center", size: 32 }) +
        fmt("që lexonte në Kindle", { align: "center", italic: true }) +
        fmt("© 2020 Autor Prove", { align: "center", pageBreakAfter: true }) +
        BODY,
    );
    const text = allText(r);
    expect(text).toContain("Rrugëtim në Amazon");
    expect(text).toContain("që lexonte në Kindle");
    expect(text).not.toContain("© 2020");
  });

  it("L3: the title page offer shows every line it would remove", async () => {
    const lines = ["NJË TITULL I GJATË PËR LIBRIN", "QË VAZHDON EDHE NË RRESHTIN E DYTË", "DHE MBARON NË VJESHTË TË VONË"];
    const r = await convert(lines.map((l) => fmt(l, { style: "Title" })).join("") + fmt("x", { pageBreakAfter: true }) + heading(1, "Kapitulli 1") + prose("Dita"), {}, true);
    expect(guessOf(r, "title_page")[0].text).toBe(lines.join(" / "));
  });
});
