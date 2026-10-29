import { Resend } from "resend";
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolveSiteOrigin } from "@/lib/site-url";
import { QUESTIONS_LINE } from "@/lib/book-review-copy";
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

// ALBANIAN-12 (PC2): Resend's batch endpoint takes up to 100 emails per
// call, and the account allows about 2 calls a second, so one email per
// follower in parallel would be refused past the first few. Batches go
// one after another with a pause between them. Best effort, like
// sendEmail: a refused or failed batch is logged (never an address) and
// the next batch is still tried.
export const EMAIL_BATCH_SIZE = 100;
export const EMAIL_BATCH_PAUSE_MS = 600;

type EmailMessage = { to: string; subject: string; html: string };

export async function sendEmailBatch(
  messages: EmailMessage[],
  { pauseMs = EMAIL_BATCH_PAUSE_MS }: { pauseMs?: number } = {},
) {
  if (messages.length === 0) return;
  if (!process.env.RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not set — skipping ${messages.length} email(s) "${messages[0].subject}"`);
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  for (let start = 0; start < messages.length; start += EMAIL_BATCH_SIZE) {
    if (start > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const batch = messages.slice(start, start + EMAIL_BATCH_SIZE).map((m) => ({ from: FROM, ...m }));
    try {
      const { error } = await resend.batch.send(batch);
      if (error) {
        console.error("Failed to send email batch: Resend refused it", {
          subject: batch[0].subject,
          count: batch.length,
          name: error.name ?? null,
          statusCode: error.statusCode ?? null,
        });
      }
    } catch (error) {
      console.error("Failed to send email batch:", error);
    }
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
  const bookUrl = `${origin}/libra/${bookId}`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Konfirmimi i blerjes suaj në Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Faleminderit për blerjen!</h1>
        <p>Bletë librin <strong>${escapeEmailHtml(book.title)}</strong> për ${amount}.</p>
        <p><a href="${bookUrl}">Shikoni librin</a></p>
      </div>`,
    );
  }

  if (author?.user?.email) {
    await sendEmail(
      author.user.email,
      "Bëtë një shitje në Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Bëtë një shitje!</h1>
        <p><strong>${escapeEmailHtml(book.title)}</strong> sapo u shit për ${amount}.</p>
        <p><a href="${origin}/dashboard/sales">Shikoni shitjet tuaja</a></p>
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
  const bundleUrl = `${origin}/paketa/${bundleId}`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Konfirmimi i blerjes suaj në Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Faleminderit për blerjen!</h1>
        <p>Bletë paketën <strong>${escapeEmailHtml(bundle.title)}</strong> për ${amount}.</p>
        <p><a href="${bundleUrl}">Shikoni paketën</a></p>
      </div>`,
    );
  }

  if (author?.user?.email) {
    await sendEmail(
      author.user.email,
      "Bëtë një shitje në Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Bëtë një shitje!</h1>
        <p>Paketa juaj <strong>${escapeEmailHtml(bundle.title)}</strong> sapo u shit për ${amount}.</p>
        <p><a href="${origin}/dashboard/sales">Shikoni shitjet tuaja</a></p>
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
  const bundleUrl = bundleId ? `${origin}/paketa/${bundleId}` : `${origin}/library`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Konfirmimi i blerjes suaj në Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Faleminderit për blerjen!</h1>
        <p>Bletë paketën <strong>${escapeEmailHtml(bundleTitle)}</strong> për ${amount}.</p>
        <p><a href="${bundleUrl}">Shikoni paketën</a></p>
      </div>`,
    );
  }

  if (author?.user?.email) {
    await sendEmail(
      author.user.email,
      "Bëtë një shitje në Librum",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Bëtë një shitje!</h1>
        <p>Paketa juaj <strong>${escapeEmailHtml(bundleTitle)}</strong> sapo u shit për ${amount}.</p>
        <p><a href="${origin}/dashboard/sales">Shikoni shitjet tuaja</a></p>
      </div>`,
    );
  }
}

// Only called on a genuine first publish (draft -> published), not on
// every unpublish/republish toggle — see the check in publishBook.
// Follower emails are looked up through the admin auth API, at most
// EMAIL_BATCH_SIZE at a time, and sent through sendEmailBatch
// (ALBANIAN-12, PC2). The pen name and title are escaped in the HTML,
// and the footer tells the reader how to stop these emails.
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

  const authorName = escapeEmailHtml(penName.name);
  const bookUrl = `${origin}/libra/${bookId}`;
  const subject = `${penName.name} publikoi një libër të ri`;
  const html = `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h1 style="font-size: 20px;">Libër i ri nga ${authorName}</h1>
          <p><strong>${escapeEmailHtml(book.title)}</strong> sapo doli në Librari.</p>
          <p><a href="${bookUrl}">Shikoni librin</a></p>
          <p style="font-size: 12px; color: #666;">E morët këtë email sepse ndiqni ${authorName} në Librum. Që të mos merrni më email të tillë, hapni <a href="${origin}/following">Autorët që ndiqni</a> dhe shtypni "Mos ndiqni më".</p>
        </div>`;

  const emails: string[] = [];
  for (let start = 0; start < follows.length; start += EMAIL_BATCH_SIZE) {
    const found = await Promise.all(
      follows.slice(start, start + EMAIL_BATCH_SIZE).map(async ({ follower_id: followerId }) => {
        const { data: follower } = await admin.auth.admin.getUserById(followerId);
        return follower?.user?.email ?? null;
      }),
    );
    for (const email of found) if (email) emails.push(email);
  }

  await sendEmailBatch(emails.map((to) => ({ to, subject, html })));
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
      ? `<p>Hoqëm nga publikimi edhe: ${bundleTitles.map((t) => `<strong>${escapeEmailHtml(t)}</strong>`).join(", ")}.</p>`
      : "";

  await sendEmail(
    to,
    "Librum e hoqi librin tuaj nga Libraria",
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">E hoqëm librin <strong>${escapeEmailHtml(title)}</strong> nga Libraria</h1>
        <p>Arsyeja: ${escapeEmailHtml(reasonLabel)}</p>
        <p>${escapeEmailHtmlWithBreaks(message)}</p>
        ${bundlesLine}
        <p>Nuk mund ta publikoni përsëri derisa ta shqyrtojmë. Lexuesit që e kanë blerë e mbajnë.</p>
        <p>${QUESTIONS_LINE}</p>
        <p><a href="${origin}/dashboard">Hapni panelin e autorit</a></p>
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
    `Libri juaj "${title}" u publikua në Librum`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Libri juaj <strong>${escapeEmailHtml(title)}</strong> u publikua në Librum</h1>
        <p>E kontrolluam dhe tani është në Librari.</p>
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin tuaj</a></p>
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
    `Librum jua ktheu "${title}" për ndryshime`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Librum jua ktheu librin <strong>${escapeEmailHtml(title)}</strong> për ndryshime</h1>
        <p>Arsyeja: ${escapeEmailHtml(reasonLabel)}</p>
        <p>${escapeEmailHtmlWithBreaks(message)}</p>
        <p>Rregullojeni dhe dërgojeni përsëri për shqyrtim.</p>
        <p>${QUESTIONS_LINE}</p>
        <p><a href="${origin}/dashboard">Hapni panelin e autorit</a></p>
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
    "Llogaria juaj në Librum u pezullua",
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Llogaria juaj në Librum u pezullua</h1>
        <p>Për momentin nuk mund të hyni në Librum.</p>
        <p>Nëse publikoni libra në Librum, ata nuk janë në Librari sa kohë që llogaria juaj është e pezulluar. Lexuesit që i kanë blerë i mbajnë.</p>
        <p>${QUESTIONS_LINE}</p>
      </div>`,
  );
}

export async function sendAccountSuspensionLiftedEmail(to: string) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    "Llogaria juaj në Librum është sërish aktive",
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Llogaria juaj në Librum është sërish aktive</h1>
        <p>Mund të hyni përsëri.</p>
        <p>Nëse publikoni libra në Librum, ata janë sërish në Librari, përveç atyre që presin shqyrtim ose që janë hequr.</p>
        <p>${QUESTIONS_LINE}</p>
        <p><a href="${origin}/login">Hyni</a></p>
      </div>`,
  );
}
