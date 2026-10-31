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
