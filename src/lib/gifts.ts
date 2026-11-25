// GIFTS (Renato 2026-11-25, item 32 batch 2; pictures b2 r1 ok): the
// gift email, the Library rows and the messages. The rules live in the
// database (migration 20261125140000_cart_gifts.sql): at most 3 emails a
// gift, one a day, a new email starts a new count (b2q3 a); the first
// signed-in reader with the link gets the book (b2q4 a). A send is
// pending until the email went out (audit S1).

import { escapeEmailHtml, sendEmailChecked } from "@/lib/email";
import { resolveSiteOrigin } from "@/lib/site-url";

export const GIFT_MAX_EMAILS = 3;
export const GIFT_TOKEN = /^[0-9a-f]{64}$/;

export type GiftStatus = "waiting" | "claimed" | "recipient_owns";

export type SentGift = {
  id: string;
  book_id: string;
  recipient_email: string;
  status: GiftStatus;
  send_count: number;
  last_sent_at: string | null;
  claimed_at: string | null;
  created_at: string;
};

// Messages the Library and the claim page show (all in page-messages.ts;
// plain constants so page-messages.sources.test.ts can read them).
export const GIFT_RESENT = "Dhurata u dërgua përsëri.";
export const GIFT_EMAIL_CHANGED = "Dhurata u dërgua te emaili i ri.";
export const GIFT_ADDED = "Dhurata u shtua në Bibliotekën tuaj.";
export const GIFT_LIMIT = "Kjo dhuratë është dërguar 3 herë. Mund ta ndryshoni emailin.";
export const GIFT_TODAY = "Mund ta dërgoni përsëri nesër.";
export const GIFT_CLAIMED = "Kjo dhuratë është marrë tashmë.";
export const GIFT_BAD_EMAIL = "Shkruani një email të saktë për personin që e merr.";
export const GIFT_FAILED = "Dhurata nuk u dërgua. Provoni përsëri.";
export const GIFT_OWN = "Këtë dhuratë e dërguat ju. Linku është për personin që e merr.";

const DATE = new Intl.DateTimeFormat("sq-AL", { day: "numeric", month: "long", timeZone: "Europe/Tirane" });

export function giftDate(iso: string): string {
  return DATE.format(new Date(iso));
}

// The grey line under a sent gift, and which buttons it gets.
export function sentGiftRow(gift: SentGift): { line: string; resend: boolean; changeEmail: boolean; sendElsewhere: boolean } {
  if (gift.status === "claimed") {
    return { line: `U mor më ${giftDate(gift.claimed_at ?? gift.created_at)}`, resend: false, changeEmail: false, sendElsewhere: false };
  }
  if (gift.status === "recipient_owns") {
    return { line: "E ka tashmë këtë libër", resend: false, changeEmail: false, sendElsewhere: true };
  }
  if (gift.send_count >= GIFT_MAX_EMAILS) {
    return { line: `Pret të merret · dërguar ${GIFT_MAX_EMAILS} herë, s’mund të dërgohet më`, resend: false, changeEmail: true, sendElsewhere: false };
  }
  return {
    line: `Pret të merret · dërguar ${giftDate(gift.last_sent_at ?? gift.created_at)}`,
    resend: true,
    changeEmail: true,
    sendElsewhere: false,
  };
}

export function giftEmail({
  buyerName,
  title,
  author,
  note,
  token,
}: {
  buyerName: string;
  title: string;
  author: string;
  note: string | null;
  token: string;
}): { subject: string; html: string } {
  const link = `${resolveSiteOrigin()}/dhurata/${token}`;
  const name = escapeEmailHtml(buyerName);
  return {
    subject: `${buyerName} ju dhuroi një libër në Librum`,
    html: `<div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1c2420;">
        <p>Përshëndetje,</p>
        <p>${name} ju dhuroi librin elektronik <strong>${escapeEmailHtml(title)}</strong> nga ${escapeEmailHtml(author)}.</p>
        ${note ? `<p style="border-left: 4px solid #c9a227; padding-left: 12px; font-style: italic;">“${escapeEmailHtml(note)}”</p>` : ""}
        <p><a href="${link}" style="display: inline-block; background: #1f3b30; color: #ffffff; padding: 10px 20px; border-radius: 999px; font-weight: bold; text-decoration: none;">Merre librin</a></p>
        <p style="font-size: 13px; color: #666;">Hyni ose krijoni një llogari falas, dhe libri shkon në Bibliotekën tuaj. Dhurata nuk skadon.</p>
        <p style="font-size: 13px; color: #666;">Librum · librum.al</p>
      </div>`,
  };
}

// true only when Resend took the email (audit S1): the caller makes the
// new link live only then.
export async function sendGiftEmail(to: string, parts: Parameters<typeof giftEmail>[0]): Promise<boolean> {
  const { subject, html } = giftEmail(parts);
  return sendEmailChecked(to, subject, html);
}
