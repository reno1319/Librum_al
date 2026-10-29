import { resolveSiteOrigin } from "@/lib/site-url";

// TRUST PACK (pipeline item 5, Renato 10-24): how readers reach Librum,
// and how long they wait for an answer (5. a: the promise shows on
// Contact, at the bottom of Help and in the footer).
export const SUPPORT_EMAIL = "support@librum.al";

export const REPLY_PROMISE = "Përgjigjemi brenda 3 ditëve të punës.";

// 6. a: the WhatsApp contact stays hidden until a number is filled in
// here, in international form with the plus sign ("+355 6X XXX XXXX";
// spaces are fine). The Contact link and the Privacy line about
// WhatsApp appear together, from this one value. Anything that isn't a
// plausible phone number keeps both hidden rather than showing a broken
// link. Renato (10-24, b): empty for now; a small patch fills it in once
// the number is on the WhatsApp Business app.
export const WHATSAPP_NUMBER = "";

// wa.me wants the digits only, without the plus sign or spaces.
export function whatsappDigits(number: string = WHATSAPP_NUMBER): string | null {
  const trimmed = number.trim();
  if (!/^\+[0-9 ]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/ /g, "");
  return /^\+[1-9][0-9]{7,14}$/.test(digits) ? digits.slice(1) : null;
}

export function isWhatsappContactLive(number: string = WHATSAPP_NUMBER): boolean {
  return whatsappDigits(number) !== null;
}

export function whatsappChatHref(number: string = WHATSAPP_NUMBER): string | null {
  const digits = whatsappDigits(number);
  return digits ? `https://wa.me/${digits}` : null;
}

// The share button on book pages (6. a): a plain link that opens
// WhatsApp with the message filled in. No number, and nothing from
// WhatsApp loads on Librum, so the Privacy page needs no line for it.
export function whatsappShareHref(message: string): string {
  return `https://wa.me/?text=${encodeURIComponent(message)}`;
}

// A book with no byline to show is shared by its title alone.
export function bookShareMessage(title: string, byline: string | null, url: string): string {
  return byline ? `${title} nga ${byline} në Librum: ${url}` : `${title} në Librum: ${url}`;
}

// Published books only (a draft or unpublished page isn't worth
// sharing). If the site's address can't be worked out, the button is
// left out rather than sharing a broken link or breaking the page.
export function bookWhatsappShareHref(
  book: { id: string; title: string; status: string },
  byline: string | null,
  origin: () => string = resolveSiteOrigin,
): string | null {
  if (book.status !== "published") return null;
  let base: string;
  try {
    base = origin();
  } catch {
    return null;
  }
  return whatsappShareHref(bookShareMessage(book.title, byline, `${base}/libra/${book.id}`));
}
