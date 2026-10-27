import { Resend } from "resend";
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolveSiteOrigin } from "@/lib/site-url";
import { formatTransactionMinorUnits, type TransactionCurrency } from "@/lib/transaction-money";

const FROM = process.env.EMAIL_FROM ?? "Librum <onboarding@resend.dev>";

// Notifications are a nice-to-have, not core functionality — never let a
// missing API key or a failed send break whatever triggered the email
// (here, recording a purchase). The Resend client is constructed lazily,
// inside the try block, since it throws immediately if no key is set.
//
// SMALL-FIXES-1 (1a): Resend reports a refused send (bad key, unverified
// domain, rate limit) by RETURNING { error }, not by throwing, so that is
// checked and logged as a failure too. Still best effort: nothing is
// thrown to the caller. No recipient address is ever logged -- and not
// Resend's message either, since some of its messages repeat the address;
// its error name and status code are enough to tell what went wrong.
// Exported for the staff alerts (src/lib/staff-alerts.ts).
export async function sendEmail(to: string, subject: string, html: string) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not set — skipping email "${subject}"`);
    return;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) {
      console.error("Failed to send email: Resend refused it", {
        subject,
        name: error.name ?? null,
        statusCode: error.statusCode ?? null,
      });
    }
  } catch (error) {
    console.error("Failed to send email:", error);
  }
}

// ALL-TXN-CURRENCY-4: every purchase email states its amount in the
// transaction's own, explicitly supplied currency, through the shared
// integer-only formatter -- never a hard-coded "$". There is no default:
// a caller that does not know the currency cannot call these at all.
function formatEmailAmount(amountCents: number, currency: TransactionCurrency): string {
  return formatTransactionMinorUnits(amountCents, currency);
}

export async function sendPurchaseEmails(
  admin: ReturnType<typeof createAdminClient>,
  {
    bookId,
    readerId,
    amountCents,
    currency,
  }: { bookId: string; readerId: string; amountCents: number; currency: TransactionCurrency },
) {
  const origin = resolveSiteOrigin();

  const { data: book } = await admin
    .from("books")
    .select("title, author_id")
    .eq("id", bookId)
    .single();

  if (!book) return;

  const [{ data: reader }, { data: author }] = await Promise.all([
    admin.auth.admin.getUserById(readerId),
    admin.auth.admin.getUserById(book.author_id),
  ]);

  const amount = formatEmailAmount(amountCents, currency);
  const bookUrl = `${origin}/books/${bookId}`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Your Librum purchase receipt",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Thanks for your purchase!</h1>
        <p>You bought <strong>${book.title}</strong> for ${amount}.</p>
        <p><a href="${bookUrl}">View your book</a></p>
      </div>`,
    );
  }

  if (author?.user?.email) {
    await sendEmail(
      author.user.email,
      "You made a sale on Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">You made a sale!</h1>
        <p><strong>${book.title}</strong> just sold for ${amount}.</p>
        <p><a href="${origin}/dashboard/sales">View your sales</a></p>
      </div>`,
    );
  }
}

export async function sendBundlePurchaseEmails(
  admin: ReturnType<typeof createAdminClient>,
  {
    bundleId,
    readerId,
    amountCents,
    currency,
  }: { bundleId: string; readerId: string; amountCents: number; currency: TransactionCurrency },
) {
  const origin = resolveSiteOrigin();

  const { data: bundle } = await admin
    .from("bundles")
    .select("title, author_id")
    .eq("id", bundleId)
    .single();

  if (!bundle) return;

  const [{ data: reader }, { data: author }] = await Promise.all([
    admin.auth.admin.getUserById(readerId),
    admin.auth.admin.getUserById(bundle.author_id),
  ]);

  const amount = formatEmailAmount(amountCents, currency);
  const bundleUrl = `${origin}/bundles/${bundleId}`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Your Librum purchase receipt",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Thanks for your purchase!</h1>
        <p>You bought the <strong>${bundle.title}</strong> bundle for ${amount}.</p>
        <p><a href="${bundleUrl}">View your bundle</a></p>
      </div>`,
    );
  }

  if (author?.user?.email) {
    await sendEmail(
      author.user.email,
      "You made a sale on Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">You made a sale!</h1>
        <p>Your <strong>${bundle.title}</strong> bundle just sold for ${amount}.</p>
        <p><a href="${origin}/dashboard/sales">View your sales</a></p>
      </div>`,
    );
  }
}

// Used only by the Stage 9B-2 snapshot-based bundle fulfillment path
// (see the Stripe webhook) -- deliberately does NOT re-read the live
// "bundles" row the way sendBundlePurchaseEmails above does, since a
// snapshot's bundle may have since been edited or deleted entirely.
// bundleTitle/authorId are passed in already resolved from the
// immutable checkout snapshot, so this never risks silently skipping
// the email just because the live bundle is gone (as
// sendBundlePurchaseEmails would, via its "if (!bundle) return").
export async function sendSnapshotBundlePurchaseEmails(
  admin: ReturnType<typeof createAdminClient>,
  {
    bundleId,
    bundleTitle,
    authorId,
    readerId,
    amountCents,
    currency,
  }: {
    bundleId: string | null;
    bundleTitle: string;
    authorId: string | null;
    readerId: string;
    amountCents: number;
    currency: TransactionCurrency;
  },
) {
  const origin = resolveSiteOrigin();

  const [{ data: reader }, { data: author }] = await Promise.all([
    admin.auth.admin.getUserById(readerId),
    authorId
      ? admin.auth.admin.getUserById(authorId)
      : Promise.resolve({ data: { user: null }, error: null }),
  ]);

  const amount = formatEmailAmount(amountCents, currency);
  // The bundle itself may no longer exist or may no longer look like
  // this purchase did -- link to the reader's library instead when
  // there's no bundle_id to point at, since that's always a valid
  // destination for what they just bought.
  const bundleUrl = bundleId ? `${origin}/bundles/${bundleId}` : `${origin}/library`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Your Librum purchase receipt",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Thanks for your purchase!</h1>
        <p>You bought the <strong>${bundleTitle}</strong> bundle for ${amount}.</p>
        <p><a href="${bundleUrl}">View your bundle</a></p>
      </div>`,
    );
  }

  if (author?.user?.email) {
    await sendEmail(
      author.user.email,
      "You made a sale on Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">You made a sale!</h1>
        <p>Your <strong>${bundleTitle}</strong> bundle just sold for ${amount}.</p>
        <p><a href="${origin}/dashboard/sales">View your sales</a></p>
      </div>`,
    );
  }
}

// Only called on a genuine first publish (draft -> published), not on
// every unpublish/republish toggle — see the check in publishBook.
// Follower emails are looked up one at a time via the admin auth API,
// same as the reader/author lookups above; fine at this project's
// scale, but would need a bulk lookup if follower counts ever got large.
export async function sendNewBookEmails(
  admin: ReturnType<typeof createAdminClient>,
  { bookId, authorId }: { bookId: string; authorId: string },
) {
  const origin = resolveSiteOrigin();

  // PEN-NAMES-1 (migration 20261019184512, 4a): readers follow a pen
  // name, so the email goes to the followers of THIS BOOK'S pen name and
  // names that pen name -- never the account, never its other pen names.
  const { data: book } = await admin
    .from("books")
    .select("title, author_id, pen_name_id")
    .eq("id", bookId)
    .single<{ title: string; author_id: string; pen_name_id: string | null }>();

  if (!book || book.author_id !== authorId || !book.pen_name_id) return;

  const [{ data: penName }, { data: follows }] = await Promise.all([
    admin
      .from("pen_names")
      .select("name")
      .eq("id", book.pen_name_id)
      .single<{ name: string }>(),
    admin.from("pen_name_follows").select("follower_id").eq("pen_name_id", book.pen_name_id),
  ]);

  if (!penName || !follows || follows.length === 0) return;

  const authorName = penName.name;
  const bookUrl = `${origin}/books/${bookId}`;

  await Promise.all(
    follows.map(async ({ follower_id: followerId }) => {
      const { data: follower } = await admin.auth.admin.getUserById(followerId);
      if (!follower?.user?.email) return;

      await sendEmail(
        follower.user.email,
        `${authorName} just published a new book`,
        `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h1 style="font-size: 20px;">New from ${authorName}</h1>
          <p><strong>${book.title}</strong> just went live.</p>
          <p><a href="${bookUrl}">View the book</a></p>
        </div>`,
      );
    }),
  );
}

// ADMIN-2-TAKEDOWN (S8): every author- or staff-supplied value in the
// takedown email (the book and bundle titles, Librum's message) is
// HTML-escaped; the message keeps its line breaks as <br>.
export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeEmailHtmlWithBreaks(value: string): string {
  return escapeEmailHtml(value).replace(/\r\n|\r|\n/g, "<br>");
}

// ADMIN-2-TAKEDOWN (2a): best effort, like every email here. The caller
// (the admin Unpublish action) reads the author's address through the
// admin auth API after the takedown has committed, never blocks on this,
// and logs a failure. The Dashboard notice is what always works.
export async function sendBookTakedownEmail(
  to: string,
  {
    title,
    reasonLabel,
    message,
    bundleTitles,
  }: { title: string; reasonLabel: string; message: string; bundleTitles: string[] },
) {
  const origin = resolveSiteOrigin();
  const bundlesLine =
    bundleTitles.length > 0
      ? `<p>We also unpublished: ${bundleTitles.map((t) => `<strong>${escapeEmailHtml(t)}</strong>`).join(", ")}.</p>`
      : "";

  await sendEmail(
    to,
    "Librum took your book down",
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">We took <strong>${escapeEmailHtml(title)}</strong> down</h1>
        <p>Reason: ${escapeEmailHtml(reasonLabel)}</p>
        <p>${escapeEmailHtmlWithBreaks(message)}</p>
        ${bundlesLine}
        <p>You can't publish it again until we review it. Readers who already bought it keep it.</p>
        <p>Questions? Write to support@librum.al</p>
        <p><a href="${origin}/dashboard">Open your dashboard</a></p>
      </div>`,
  );
}

// ADMIN-3-REVIEW (J): best effort, like the takedown email. The caller
// (the admin Approve / Send back action) reads the author's address
// through the admin auth API after the RPC has committed, never blocks
// on this, and logs a failure. The Dashboard is what always works.
export async function sendBookApprovedEmail(to: string, { title, bookId }: { title: string; bookId: string }) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Your book “${title}” is live on Librum`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Your book <strong>${escapeEmailHtml(title)}</strong> is live on Librum</h1>
        <p>We checked it and it's now in the Bookstore.</p>
        <p><a href="${origin}/books/${encodeURIComponent(bookId)}">See your book</a></p>
      </div>`,
  );
}

export async function sendBookSentBackEmail(
  to: string,
  { title, reasonLabel, message }: { title: string; reasonLabel: string; message: string },
) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Librum sent “${title}” back`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Librum sent <strong>${escapeEmailHtml(title)}</strong> back</h1>
        <p>Reason: ${escapeEmailHtml(reasonLabel)}</p>
        <p>${escapeEmailHtmlWithBreaks(message)}</p>
        <p>Fix it and send it for review again. Questions? Write to support@librum.al</p>
        <p><a href="${origin}/dashboard">Open your dashboard</a></p>
      </div>`,
  );
}

// PEOPLE-2 (7b, F2a): best effort, like every email here. The caller (the
// admin Suspend / Lift action) reads the address through the admin auth
// API after the RPC has committed, never blocks on this, and logs a
// failure. No reason is ever included: the reason is for staff only (6a).
export async function sendAccountSuspendedEmail(to: string) {
  await sendEmail(
    to,
    "Your Librum account is suspended",
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Your Librum account is suspended</h1>
        <p>You can't sign in to Librum for now.</p>
        <p>If you publish books on Librum, they are out of the Bookstore while your account is suspended. Readers who already bought them keep them.</p>
        <p>Questions? Write to support@librum.al</p>
      </div>`,
  );
}

export async function sendAccountSuspensionLiftedEmail(to: string) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    "Your Librum account is active again",
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Your Librum account is active again</h1>
        <p>You can sign in again.</p>
        <p>If you publish books on Librum, they are back in the Bookstore, except any that need review or were taken down.</p>
        <p>Questions? Write to support@librum.al</p>
        <p><a href="${origin}/login">Log in</a></p>
      </div>`,
  );
}
