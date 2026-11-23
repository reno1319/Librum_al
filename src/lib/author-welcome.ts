import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { authorRecipient } from "@/lib/author-recipient";
import { sendAuthorWelcomeEmail, sendHouseWelcomeEmail } from "@/lib/email";

/**
 * AUTHOR-EMAILS (Renato 11-17, mail2 b + mail3 a): every author account
 * gets the welcome email once -- at its first confirmed sign-in as an
 * author (email link or Google), or when a reader becomes an author.
 *
 * Once only: profiles.author_welcome_sent_at is claimed (set where it is
 * still null and the account is an author) BEFORE the send, so a double
 * click, a refresh or two tabs never send twice. A failed send is not
 * retried (best effort, like every email here). Accounts that were
 * already authors when the column came were marked by the migration.
 * Readers get nothing yet (their text comes later). A publishing house
 * (BUILD 2a-2) is claimed the same way and gets the house welcome.
 */
export async function sendAuthorWelcomeOnce(userId: string): Promise<void> {
  try {
    const admin = createAdminClient();
    const { data: claimed, error } = await admin
      .from("profiles")
      .update({ author_welcome_sent_at: new Date().toISOString() })
      .eq("id", userId)
      .eq("role", "author")
      .is("author_welcome_sent_at", null)
      .select("id, account_kind, public_author_name");
    if (error) {
      console.error("author welcome: the claim failed", { code: error.code ?? null });
      return;
    }
    if (!Array.isArray(claimed) || claimed.length !== 1) return;
    const recipient = await authorRecipient(admin, userId);
    if (!recipient) return;
    // BUILD 2a-2 (h4 ok): a publishing house gets its own welcome ("ju"),
    // greeted by the house name (its public name), not a person's name.
    const row = claimed[0] as { account_kind?: unknown; public_author_name?: unknown };
    if (row.account_kind === "publishing_house") {
      const houseName =
        typeof row.public_author_name === "string" && row.public_author_name.trim() !== ""
          ? row.public_author_name.replace(/\s+/g, " ").trim().slice(0, 80).trim()
          : recipient.name;
      await sendHouseWelcomeEmail(recipient.email, { name: houseName });
      return;
    }
    await sendAuthorWelcomeEmail(recipient.email, { name: recipient.name });
  } catch (welcomeError) {
    console.error("author welcome: failed", { error: welcomeError });
  }
}

/** Runs sendAuthorWelcomeOnce after the response; never throws. */
export function scheduleAuthorWelcome(userId: string): void {
  try {
    after(() => sendAuthorWelcomeOnce(userId));
  } catch (scheduleError) {
    console.error("author welcome: could not be scheduled", { error: scheduleError });
  }
}
