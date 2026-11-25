"use server";

// GIFTS (Renato 2026-11-25, item 32 batch 2): claiming a gift from its
// link, and the buyer's two buttons in the Library. Every call goes
// through the reader's own session; the database functions of migration
// 20261125140000_cart_gifts.sql decide (who may, how often) and hand back
// a fresh PENDING link once, for the email. The link goes live (and the
// email counts) only after Resend took the email; otherwise it is
// cancelled and nothing is used up (audit S1).

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import { resolveBookByline } from "@/lib/book-byline";
import {
  GIFT_ADDED,
  GIFT_BAD_EMAIL,
  GIFT_CLAIMED,
  GIFT_EMAIL_CHANGED,
  GIFT_FAILED,
  GIFT_LIMIT,
  GIFT_OWN,
  GIFT_RESENT,
  GIFT_TODAY,
  GIFT_TOKEN,
  sendGiftEmail,
} from "@/lib/gifts";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";

type Supabase = Awaited<ReturnType<typeof createClient>>;
type SendRow = { recipient_email: string; token: string; book_id: string; buyer_name: string; note: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function signedInUser(next: string) {
  await redirectIfRecoverySessionActive();
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return { supabase, user };
}

// A refusal from gift_resend / gift_change_email / gift_confirm_send
// (LB531-LB533; anything else, e.g. LB535 a send still pending, is
// "try again"), shown in the Library.
function refused(code: string | undefined): never {
  if (code === "LB531") redirect(`/library?error=${encodeURIComponent(GIFT_LIMIT)}#dhuratat`);
  if (code === "LB532") redirect(`/library?error=${encodeURIComponent(GIFT_TODAY)}#dhuratat`);
  if (code === "LB533") redirect(`/library?error=${encodeURIComponent(GIFT_CLAIMED)}#dhuratat`);
  redirect(`/library?error=${encodeURIComponent(GIFT_FAILED)}#dhuratat`);
}

// Sends the email with the pending link, then makes it live. false: the
// email did not go out, the pending link was dropped, nothing changed.
async function emailTheGift(supabase: Supabase, giftId: string, row: SendRow): Promise<boolean> {
  const { data: book } = await supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .eq("id", row.book_id)
    .maybeSingle<PublicBook & { pen: PenNameRef | null }>();
  const sent = await sendGiftEmail(row.recipient_email, {
    buyerName: row.buyer_name,
    title: book?.title ?? "një libër",
    author: (book ? resolveBookByline(book) : null) ?? "Librum",
    note: row.note,
    token: row.token,
  });
  if (!sent) {
    await supabase.rpc("gift_cancel_send", { p_gift_id: giftId, p_token: row.token });
    return false;
  }
  const { error } = await supabase.rpc("gift_confirm_send", { p_gift_id: giftId, p_token: row.token });
  if (error) refused(error.code);
  return true;
}

export async function claimGift(token: string) {
  if (!GIFT_TOKEN.test(token)) redirect("/");
  const { supabase } = await signedInUser(`/dhurata/${token}`);
  const { data, error } = await supabase.rpc("claim_gift", { p_token: token });
  if (error) {
    redirect(`/dhurata/${token}?error=${encodeURIComponent(GIFT_FAILED)}`);
  }
  if (data === "claimed") {
    revalidatePath("/library");
    redirect(`/library?success=${encodeURIComponent(GIFT_ADDED)}`);
  }
  if (data === "owned") redirect(`/dhurata/${token}?e-keni=1`);
  if (data === "own_gift") redirect(`/dhurata/${token}?error=${encodeURIComponent(GIFT_OWN)}`);
  // 'used', 'invalid': the page itself says so.
  redirect(`/dhurata/${token}`);
}

export async function resendGift(giftId: string) {
  if (!UUID.test(giftId)) refused(undefined);
  const { supabase } = await signedInUser("/library");
  const { data, error } = await supabase.rpc("gift_resend", { p_gift_id: giftId }).maybeSingle<SendRow>();
  if (error || !data) refused(error?.code);
  if (!(await emailTheGift(supabase, giftId, data))) {
    redirect(`/library?error=${encodeURIComponent(GIFT_FAILED)}#dhuratat`);
  }
  revalidatePath("/library");
  redirect(`/library?success=${encodeURIComponent(GIFT_RESENT)}#dhuratat`);
}

export async function changeGiftEmail(giftId: string, formData: FormData) {
  if (!UUID.test(giftId)) refused(undefined);
  const back = `/library/dhurata/${giftId}`;
  const { supabase } = await signedInUser(back);
  const raw = formData.get("email");
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (email.length < 3 || email.length > 254 || !EMAIL.test(email)) {
    redirect(`${back}?error=${encodeURIComponent(GIFT_BAD_EMAIL)}`);
  }
  const { data, error } = await supabase
    .rpc("gift_change_email", { p_gift_id: giftId, p_email: email })
    .maybeSingle<SendRow>();
  if (error?.code === "LB534") redirect(`${back}?error=${encodeURIComponent(GIFT_BAD_EMAIL)}`);
  if (error || !data) refused(error?.code);
  if (!(await emailTheGift(supabase, giftId, data))) {
    redirect(`${back}?error=${encodeURIComponent(GIFT_FAILED)}`);
  }
  revalidatePath("/library");
  redirect(`/library?success=${encodeURIComponent(GIFT_EMAIL_CHANGED)}#dhuratat`);
}
