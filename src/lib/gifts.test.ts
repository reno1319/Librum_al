import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/site-url", () => ({ resolveSiteOrigin: () => "https://librum.al" }));
vi.mock("@/lib/email", () => ({
  sendEmailChecked: vi.fn(),
  escapeEmailHtml: (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
}));

import { GIFT_TOKEN, giftEmail, sentGiftRow, type SentGift } from "./gifts";

const base: SentGift = {
  id: "g1",
  book_id: "b1",
  recipient_email: "miku@example.test",
  status: "waiting",
  send_count: 1,
  last_sent_at: "2026-11-25T10:00:00Z",
  claimed_at: null,
  created_at: "2026-11-25T10:00:00Z",
};

describe("sentGiftRow (b2q3 a, g2 a, g3 a)", () => {
  it("a waiting gift can be resent or get a new email", () => {
    expect(sentGiftRow(base)).toEqual({
      line: "Pret të merret · dërguar 25 nëntor",
      resend: true,
      changeEmail: true,
      sendElsewhere: false,
    });
  });

  it("after 3 emails only the email can change", () => {
    const row = sentGiftRow({ ...base, send_count: 3 });
    expect(row.line).toBe("Pret të merret · dërguar 3 herë, s’mund të dërgohet më");
    expect(row).toMatchObject({ resend: false, changeEmail: true, sendElsewhere: false });
  });

  it("a friend who owns the book: send it to someone else", () => {
    expect(sentGiftRow({ ...base, status: "recipient_owns" })).toEqual({
      line: "E ka tashmë këtë libër",
      resend: false,
      changeEmail: false,
      sendElsewhere: true,
    });
  });

  it("a claimed gift has no buttons", () => {
    expect(sentGiftRow({ ...base, status: "claimed", claimed_at: "2026-11-20T12:00:00Z" })).toEqual({
      line: "U mor më 20 nëntor",
      resend: false,
      changeEmail: false,
      sendElsewhere: false,
    });
  });
});

describe("giftEmail (b2q1 a, b2q4 a)", () => {
  const token = "a".repeat(64);

  it("names the buyer, the book and links to the gift page", () => {
    const { subject, html } = giftEmail({ buyerName: "Ana", title: "Kopshti i Gurtë", author: "Autor Shembull", note: "Gëzuar!", token });
    expect(subject).toBe("Ana ju dhuroi një libër në Librum");
    expect(html).toContain("Ana ju dhuroi librin elektronik <strong>Kopshti i Gurtë</strong> nga Autor Shembull.");
    expect(html).toContain(`href="https://librum.al/dhurata/${token}"`);
    expect(html).toContain("“Gëzuar!”");
    expect(html).toContain("Hyni ose krijoni një llogari falas, dhe libri shkon në Bibliotekën tuaj.");
    expect(html).not.toContain("me këtë email");
  });

  it("escapes what the buyer typed and leaves out an empty note", () => {
    const { html } = giftEmail({ buyerName: "<b>X</b>", title: "T", author: "A", note: null, token });
    expect(html).toContain("&lt;b&gt;X&lt;/b&gt; ju dhuroi");
    expect(html).not.toContain("border-left");
  });

  it("a link token is 64 lower-case hex characters", () => {
    expect(GIFT_TOKEN.test(token)).toBe(true);
    expect(GIFT_TOKEN.test("A".repeat(64))).toBe(false);
    expect(GIFT_TOKEN.test("a".repeat(63))).toBe(false);
  });
});
