import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { escapeEmailHtml, sendEmail } from "@/lib/email";
import { SUPPORT_EMAIL } from "@/lib/contact";
import { resolveSiteOrigin } from "@/lib/site-url";

// G4 (Renato 11-24, g4q2 a, g4q7 a): after a pre-order reader sweep had
// failures, one short email to support@librum.al, at most one a Tirana
// day. claim_preorder_failure_alert() (migration 20261124180000, service
// role) counts the failures since the last alert and stamps the alert
// under a row lock, so two sweeps at once send at most one. Only the
// count and a link: no reader address, name or book (they are on the
// admin Today page). Its own limit, not the error emails' (N18).
// Production only, like the error emails, so previews and local runs
// never email support. Best effort: never throws. Once claimed, a send
// that fails is not retried that day; the Today box still shows the rows.

type AdminClient = ReturnType<typeof createAdminClient>;

export function preorderFailureAlertEmail(count: number): { subject: string; html: string } {
  const n = Math.max(1, Math.floor(count));
  const noun = n === 1 ? "pre-order email" : "pre-order emails";
  const link = `${resolveSiteOrigin()}/admin`;
  return {
    subject: `Librum: ${n} ${noun} failed`,
    html: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">${n} ${noun} failed</h1>
        <p>Since the last alert, ${n} ${n === 1 ? "email" : "emails"} to readers who pre-ordered a book (“book is out” or “pre-order cancelled”) did not go out, or may not have.</p>
        <p><a href="${escapeEmailHtml(link)}">Open the admin Today page</a> to see them, send them again or mark them handled.</p>
        <p style="font-size: 12px; color: #666;">At most one of these emails a day. Reader addresses are never in this email.</p>
      </div>`,
  };
}

export async function alertPreorderEmailFailures(admin: AdminClient): Promise<number> {
  try {
    if (process.env.VERCEL_ENV !== "production") return 0;
    const { data, error } = await admin.rpc("claim_preorder_failure_alert");
    if (error) {
      console.error("preorder failure alert: the claim failed", { code: error.code ?? null });
      return 0;
    }
    const count = typeof data === "number" && Number.isInteger(data) && data > 0 ? data : 0;
    if (count === 0) return 0;
    const { subject, html } = preorderFailureAlertEmail(count);
    await sendEmail(SUPPORT_EMAIL, subject, html);
    console.log("[preorders] failure alert sent", { count });
    return count;
  } catch (alertError) {
    console.error("preorder failure alert: failed", { error: alertError });
    return 0;
  }
}
