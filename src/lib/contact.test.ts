import { describe, expect, it } from "vitest";
import {
  REPLY_PROMISE,
  SUPPORT_EMAIL,
  WHATSAPP_NUMBER,
  bookWhatsappShareHref,
  isWhatsappContactLive,
  whatsappChatHref,
  whatsappDigits,
  whatsappShareHref,
} from "./contact";
import { TEAM, visibleTeam } from "./team";

// TRUST PACK (pipeline item 5): the contact slot and the share link.
describe("TRUST PACK: contact details", () => {
  it("promises a reply within 3 working days at support@librum.al", () => {
    expect(SUPPORT_EMAIL).toBe("support@librum.al");
    expect(REPLY_PROMISE).toBe("Përgjigjemi brenda 3 ditëve të punës.");
  });

  it("is empty until the number is on the WhatsApp Business app (Renato 10-24, b)", () => {
    expect(WHATSAPP_NUMBER).toBe("");
    expect(isWhatsappContactLive()).toBe(false);
    expect(whatsappChatHref()).toBeNull();
  });

  it("goes live once a valid number is filled in", () => {
    expect(isWhatsappContactLive("+355 60 000 0000")).toBe(true);
    expect(whatsappChatHref("+355 60 000 0000")).toBe("https://wa.me/355600000000");
  });

  it("stays hidden for an empty or malformed number", () => {
    for (const bad of ["", "   ", "0600000000", "355600000000", "+355 60-000", "+0 123 456 789", "+12", "+355 60 000 0000 x1", "+1234567890123456"]) {
      expect(whatsappDigits(bad)).toBeNull();
      expect(isWhatsappContactLive(bad)).toBe(false);
      expect(whatsappChatHref(bad)).toBeNull();
    }
    expect(whatsappDigits(" +355 60 000 0000 ")).toBe("355600000000");
  });
});

describe("TRUST PACK: WhatsApp share link", () => {
  const book = { id: "b1", title: "Kronikë & Gur?", status: "published" };

  it("is a plain wa.me link with the message encoded", () => {
    expect(whatsappShareHref("a b&c")).toBe("https://wa.me/?text=a%20b%26c");
    const href = bookWhatsappShareHref(book, "Ana", () => "https://librum.al");
    expect(href).toBe(
      `https://wa.me/?text=${encodeURIComponent("Kronikë & Gur? by Ana on Librum: https://librum.al/books/b1")}`,
    );
  });

  it("drops the byline when the book has none", () => {
    expect(bookWhatsappShareHref(book, null, () => "https://librum.al")).toBe(
      `https://wa.me/?text=${encodeURIComponent("Kronikë & Gur? on Librum: https://librum.al/books/b1")}`,
    );
  });

  it("is left out for unpublished books and when the site address fails", () => {
    expect(bookWhatsappShareHref({ ...book, status: "draft" }, "Ana", () => "https://librum.al")).toBeNull();
    expect(
      bookWhatsappShareHref(book, "Ana", () => {
        throw new Error("NEXT_PUBLIC_SITE_URL is not configured");
      }),
    ).toBeNull();
  });
});

describe("TRUST PACK: team slot", () => {
  it("is empty until the team sends its own words", () => {
    expect(TEAM).toEqual([]);
    expect(visibleTeam()).toEqual([]);
  });

  it("leaves out a member with any empty field", () => {
    const full = { name: "A", role: "B", bio: "C" };
    expect(visibleTeam([full])).toEqual([full]);
    for (const key of ["name", "role", "bio"] as const) {
      expect(visibleTeam([{ ...full, [key]: " " }])).toEqual([]);
    }
  });
});
