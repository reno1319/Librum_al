import "server-only";
import type { User } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/admin";
import { sendBookApprovedEmail } from "@/lib/email";

type AdminClient = ReturnType<typeof createAdminClient>;

const GREETING_NAME_MAX = 80;

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/\s+/g, " ").trim().slice(0, GREETING_NAME_MAX).trim();
  return name === "" ? null : name;
}

/**
 * AUTHOR-EMAILS (mail10 a): the name an author email greets. The
 * account name, except for a Google sign-up whose account name is still
 * the automatic one (the part of the address before "@", set by
 * handle_new_user()): then Google's own name, else none ("Përshëndetje,").
 * Never a pen name; only the author reads these emails.
 */
export function authorGreetingName(
  user: { email?: string | null; app_metadata?: Partial<User["app_metadata"]> | null; user_metadata?: unknown },
  displayName: unknown,
): string | null {
  const accountName = cleanName(displayName);
  const provider = user.app_metadata?.provider;
  const localPart = typeof user.email === "string" ? user.email.split("@")[0] : null;
  if (provider === "google" && (accountName === null || accountName === localPart)) {
    const metadata =
      user.user_metadata && typeof user.user_metadata === "object" ? (user.user_metadata as Record<string, unknown>) : {};
    return cleanName(metadata.full_name) ?? cleanName(metadata.name);
  }
  return accountName;
}

/** The author's address and greeting name, or null when there is no address. */
export async function authorRecipient(
  admin: AdminClient,
  authorId: string,
): Promise<{ email: string; name: string | null } | null> {
  const { data } = await admin.auth.admin.getUserById(authorId);
  const user = data?.user;
  if (!user?.email) return null;
  const { data: profile } = await admin
    .from("profiles")
    .select("display_name")
    .eq("id", authorId)
    .maybeSingle<{ display_name: string | null }>();
  return { email: user.email, name: authorGreetingName(user, profile?.display_name ?? null) };
}

/**
 * AUTHOR-EMAILS: the "book published" email, greeting the author by
 * name. The name stays inside this helper, so the staff Approve action
 * that calls it never reads the author's profile (PEN-NAMES-2 guard).
 */
export async function sendBookApprovedEmailToAuthor(
  admin: AdminClient,
  authorId: string,
  mail: { title: string; bookId: string },
): Promise<void> {
  const recipient = await authorRecipient(admin, authorId);
  if (recipient) await sendBookApprovedEmail(recipient.email, { ...mail, name: recipient.name });
}
