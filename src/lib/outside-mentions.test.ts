import { describe, expect, it } from "vitest";
import { findOutsideMentions, hasOutsideMention, outsideMentionMessages } from "./outside-mentions";

describe("findOutsideMentions (BD3 patch 2)", () => {
  it("names the stores found, once each", () => {
    expect(findOutsideMentions("Në Amazon, në amazon.com dhe në Kindle; edhe Apple Books, Google Play, Kobo, Libra24.").stores).toEqual([
      "Amazon",
      "Kindle",
      "Apple Books",
      "Google Play",
      "Kobo",
    ]);
  });

  it("does not take ordinary words for stores", () => {
    expect(findOutsideMentions("Ajo hëngri një apple, luajti (play) me Lulun dhe lexoi në nook-un e dhomës.").stores).toEqual([]);
  });

  it("finds emails and phone numbers, not Librum's address, a year or an ISBN", () => {
    const m = findOutsideMentions("a@b.al, support@librum.al, 069 123 4567, +383 44 123 456, 2026, ISBN 978-9928-00-000-0, 1998-2001");
    expect(m.emails).toEqual(["a@b.al"]);
    expect(m.phones).toEqual(["069 123 4567", "+383 44 123 456"]);
  });

  it("hasOutsideMention and the Albanian messages", () => {
    expect(hasOutsideMention("Tekst i zakonshëm.")).toBe(false);
    expect(hasOutsideMention("Na gjeni në Wattpad.")).toBe(true);
    const msg = outsideMentionMessages({ stores: [], emails: [], phones: [] });
    expect(msg).toEqual({ store: null, contact: null });
  });
});
