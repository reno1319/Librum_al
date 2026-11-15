import { describe, expect, it } from "vitest";
import { buyerLineHtml, parseSavedPosition, positionStorageKey, readConfirmed } from "@/lib/owned-reader";
import { buyerLineText } from "@/lib/epub-librum-pages";
import { READER_CLASSES } from "@/lib/reader-content";

describe("buyer reader helpers (11-15)", () => {
  it("2a: the online line is the download's own buyer line", () => {
    const text = buyerLineText({ email: "lexues@example.test", date: "15 nëntor 2026", code: "LB-7K2Q9", free: false });
    expect(text).toBe("Blerë nga lexues@example.test më 15 nëntor 2026 · Kodi i blerjes: LB-7K2Q9");
    expect(buyerLineText({ email: "a@example.test", date: "1 nëntor 2026", code: "X", free: true })).toMatch(/^Shkarkuar falas nga a@example\.test/);
  });

  it("escapes the line and uses only the reader's own classes", () => {
    const html = buyerLineHtml(`Blerë nga "x"<img src=x onerror=1>&@example.test`);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=1&gt;&amp;");
    expect(html).toContain("&quot;x&quot;");
    for (const cls of [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(" "))) {
      expect(READER_CLASSES as readonly string[]).toContain(cls);
    }
  });

  it("1a: only ?accept=1 confirms the first open", () => {
    expect(readConfirmed(new URLSearchParams("accept=1"))).toBe(true);
    expect(readConfirmed(new URLSearchParams(""))).toBe(false);
    expect(readConfirmed(new URLSearchParams("accept=true"))).toBe(false);
    expect(readConfirmed(new URLSearchParams("accept=0&accept=1"))).toBe(false);
  });

  it("3a: a saved place is a number from 0 to 1, per book", () => {
    expect(positionStorageKey("b1")).toBe("librum-reader-place:b1");
    expect(parseSavedPosition("0.42")).toBe(0.42);
    expect(parseSavedPosition("0")).toBe(0);
    expect(parseSavedPosition("1")).toBe(1);
    for (const bad of [null, "", " ", "-0.1", "1.01", "NaN", "abc", "Infinity"]) expect(parseSavedPosition(bad)).toBeNull();
  });
});
