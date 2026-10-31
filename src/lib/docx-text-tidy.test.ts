import { describe, expect, it } from "vitest";
import { detectDialogueDash, detectQuoteStyle, emptyTidyCounts, tidyText, type QuoteStyle } from "./docx-text-tidy";

function tidy(text: string, quoteStyle: QuoteStyle = "curly", dialogueDash: "—" | "–" = "—") {
  const counts = emptyTidyCounts();
  return { text: tidyText(text, { quoteStyle, dialogueDash }, counts).join(""), counts };
}

describe("W3 text tidy", () => {
  it("detects the author's quote habit", () => {
    expect(detectQuoteStyle("Ai tha “po”.")).toBe("curly");
    expect(detectQuoteStyle("Ai tha „po“. Ajo «jo».  „Po“")).toBe("low9");
    expect(detectQuoteStyle("Ajo tha «jo».")).toBe("guillemets");
  });

  it("curls straight double quotes in the author's style", () => {
    expect(tidy('Ai tha: "Po." Pastaj "Jo".').text).toBe("Ai tha: “Po.” Pastaj “Jo”.");
    expect(tidy('Ai tha: "Po."', "low9").text).toBe("Ai tha: „Po.“");
    expect(tidy('Ai tha: "Po."', "guillemets").text).toBe("Ai tha: «Po.»");
    expect(tidy('("Po")').text).toBe("(“Po”)");
  });

  it("turns elision apostrophes into ’, never into an opening quote", () => {
    expect(tidy("S'ishte larg ç'mendonim, s'e gjeti, t' ia shkruaj").text).toBe("S’ishte larg ç’mendonim, s’e gjeti, t’ ia shkruaj");
    expect(tidy("'i thashë").text).toBe("’i thashë");
    expect(tidy("Ai tha 'kujdes' dhe iku.").text).toBe("Ai tha ‘kujdes’ dhe iku.");
    expect(tidy("Vitet '90").text).toBe("Vitet ’90");
  });

  // Found in the staging footnote try-out (31 Oct): a quoted phrase that
  // ends in its own punctuation came out as ’Mos e kërko më,' -- an
  // opening quote turned into a closing one, the closing one left straight.
  it.each([
    ["'Mos e kërko më,' i tha plaku, 'deti i mban sekretet e veta.'", "‘Mos e kërko më,’ i tha plaku, ‘deti i mban sekretet e veta.’"],
    ["'Po.' tha ai.", "‘Po.’ tha ai."],
    ["'Vjen?' pyeti.", "‘Vjen?’ pyeti."],
    ["'Vjen?!' pyeti.", "‘Vjen?!’ pyeti."],
    ["'Prit...' tha.", "‘Prit…’ tha."],
    ["'Prit…' tha.", "‘Prit…’ tha."],
    ["'Ik!'", "‘Ik!’"],
    ["'Kujdes;' pastaj iku.", "‘Kujdes;’ pastaj iku."],
    // Elisions inside the phrase stay apostrophes and don't end it.
    ["'S'e di,' tha.", "‘S’e di,’ tha."],
    ["'Ai s' e di,' tha.", "‘Ai s’ e di,’ tha."],
    ["'You're late.' tha.", "‘You’re late.’ tha."],
    // Inside double quotes, and after an opening bracket or dash.
    ['"Ai tha: \'Po.\'"', "“Ai tha: ‘Po.’”"],
    ["('Po,' tha)", "(‘Po,’ tha)"],
    ["—'Po,' tha.", "—‘Po,’ tha."],
    // Two phrases in one paragraph, the first closing at a word.
    ["'kujdes' dhe 'Po,' tha.", "‘kujdes’ dhe ‘Po,’ tha."],
  ])("closes a single-quoted phrase after its own punctuation: %s", (input, expected) => {
    const r = tidy(input);
    expect(r.text).toBe(expected);
    expect(r.text).not.toContain("'");
  });

  it("still leaves a stray quote after punctuation alone when no phrase is open", () => {
    expect(tidy("Po,' tha ai.").text).toBe("Po,' tha ai.");
    expect(tidy("Fund. ' Pastaj").text).toBe("Fund. ' Pastaj");
    // An opener with no close anywhere stays an elision.
    expect(tidy("'i thashë, po.").text).toBe("’i thashë, po.");
    // Punctuation followed by a letter is not a close: "a,'b".
    expect(tidy("'Po,'b tha").text).toBe("’Po,'b tha");
  });

  // Audit W3SW r1 (passed on r1, kept as permanent tests).
  it.each([
    ["'Po:' kështu.", "‘Po:’ kështu."],
    // A phrase closed at a word, or after punctuation, lets no later stray quote close.
    ["'kujdes' dhe po,' tha.", "‘kujdes’ dhe po,' tha."],
    ["'Po,' tha, po,' x", "‘Po,’ tha, po,' x"],
    ["'Ç'ke?' pyeti.", "‘Ç’ke?’ pyeti."],
    ["'T'i thuash, s'do.' tha.", "‘T’i thuash, s’do.’ tha."],
    ["'Mirë mëngjes!', tha.", "‘Mirë mëngjes!’, tha."],
    ["'Ku je?'\u00a0tha.", "‘Ku je?’\u00a0tha."],
    // A single-letter elision with no close never opens.
    ["'i s' po", "’i s’ po"],
    // A typed curly opener with a straight close is left alone, as before.
    ["‘Po,' tha.", "‘Po,' tha."],
  ])("audit case %s", (input, expected) => {
    expect(tidy(input).text).toBe(expected);
  });

  // Audit W3SW r1 N1: a year or an elision never opens a phrase.
  it.each([
    ["Në vitet '90 ai tha: 'Iku.'", "Në vitet ’90 ai tha: ‘Iku.’"],
    ["Vitet '90, pastaj vitet 2000.' tha.", "Vitet ’90, pastaj vitet 2000.' tha."],
    ["'Rock 'n' roll,' tha.", "‘Rock ’n’ roll,’ tha."],
    ["'90-ta ishin, tha ai.'", "’90-ta ishin, tha ai.'"],
    ["'Në '44,' tha.", "‘Në ’44,’ tha."],
  ])("keeps the apostrophe in %s", (input, expected) => {
    expect(tidy(input).text).toBe(expected);
  });

  it("still opens a phrase that starts with a longer number or a two-digit word", () => {
    expect(tidy("'1990 ishte vit i mirë,' tha.").text).toBe("‘1990 ishte vit i mirë,’ tha.");
    expect(tidy("'90a,' tha.").text).toBe("‘90a,’ tha.");
    expect(tidy("'7, 8, 9,' numëroi.").text).toBe("‘7, 8, 9,’ numëroi.");
  });

  it("counts each converted single quote once", () => {
    expect(tidy("'Mos,' tha, 'jo.'").counts.apostrophes).toBe(4);
  });

  it("tidies three dots and a spaced double hyphen, leaves other runs", () => {
    expect(tidy("Prit... pra -- fund.").text).toBe("Prit… pra — fund.");
    expect(tidy("Prit.... a-b--c").text).toBe("Prit.... a-b--c");
  });

  it("gives hyphen dialogue the author's main dash", () => {
    expect(detectDialogueDash(["— Po.", "— Jo.", "– Ndoshta."])).toBe("—");
    expect(detectDialogueDash(["– Po.", "– Jo."])).toBe("–");
    expect(detectDialogueDash(["Pa dialog."])).toBe("—");
    expect(tidy("- Po, - tha ai - me zë.").text).toBe("— Po, — tha ai — me zë.");
    expect(tidy("- Po.", "curly", "–").text).toBe("– Po.");
    // A hyphen inside an ordinary sentence is left alone.
    expect(tidy("Tiranë - Durrës").text).toBe("Tiranë - Durrës");
  });

  it("counts what it changed", () => {
    expect(tidy('"Po" s\'e... -- - x').counts).toEqual({ quotes: 2, apostrophes: 1, ellipses: 1, dashes: 1 });
  });

  it("returns one entry per input character so it can be written back into Word's runs", () => {
    const input = 'a"b...c😀';
    const out = tidyText(input, { quoteStyle: "curly", dialogueDash: "—" }, emptyTidyCounts());
    expect(out).toHaveLength(Array.from(input).length);
  });
});
