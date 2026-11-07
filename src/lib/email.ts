import { Resend } from "resend";
import type { createAdminClient } from "@/lib/supabase/admin";
import { resolveSiteOrigin } from "@/lib/site-url";
import { LIVE_SENT_BACK_FIX_LINE, QUESTIONS_LINE, SENT_BACK_FIX_LINE } from "@/lib/book-review-copy";
import { formatTransactionMinorUnits, type TransactionCurrency } from "@/lib/transaction-money";
import { formatDateOnly } from "@/lib/book-detail-dates";

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

// BD16 P5 r2 (audit F2): callers that mark an email as sent before
// sending it (the pre-order emails) check this first, so a deploy
// without the key marks nothing.
export function emailSendingConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

// BD16 P5 r3 (audit G1, G2): what a caller that marks emails as sent
// before sending (the pre-order emails) needs to know. notSent: the
// indexes (into messages) that were DEFINITELY not sent -- no key, or a
// request Resend answered with a refusal status (400, 401, 403, 422,
// 429: it refused before sending anything). invalid: with permissive
// validation, the emails Resend refused one by one (a bad address);
// permanent, so never retried. Anything else -- a dropped connection, a
// timeout, a 5xx, no status at all (resend@6 returns these as { error }
// with statusCode null or 5xx, it never throws), or a throw -- is an
// UNKNOWN outcome: Resend may have sent it, so it is in neither list and
// the caller keeps it marked (at most once, never twice).
export type EmailBatchResult = { notSent: number[]; invalid: number[] };

const DEFINITE_REFUSAL_STATUSES = new Set([400, 401, 403, 422, 429]);

export function isDefiniteRefusal(statusCode: unknown): boolean {
  return typeof statusCode === "number" && DEFINITE_REFUSAL_STATUSES.has(statusCode);
}

export async function sendEmailBatch(
  messages: EmailMessage[],
  { pauseMs = EMAIL_BATCH_PAUSE_MS, permissive = false }: { pauseMs?: number; permissive?: boolean } = {},
): Promise<EmailBatchResult> {
  const notSent: number[] = [];
  const invalid: number[] = [];
  if (messages.length === 0) return { notSent, invalid };
  if (!process.env.RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not set — skipping ${messages.length} email(s) "${messages[0].subject}"`);
    return { notSent: messages.map((_m, i) => i), invalid };
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  for (let start = 0; start < messages.length; start += EMAIL_BATCH_SIZE) {
    if (start > 0 && pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    const batch = messages.slice(start, start + EMAIL_BATCH_SIZE).map((m) => ({ from: FROM, ...m }));
    try {
      // G2: permissive validation sends the valid emails of a batch and
      // lists the invalid ones, so one bad address can't hold back the rest.
      const { data, error } = permissive
        ? await resend.batch.send(batch, { batchValidation: "permissive" })
        : await resend.batch.send(batch);
      if (error) {
        const definite = isDefiniteRefusal(error.statusCode);
        console.error(
          definite
            ? "Failed to send email batch: Resend refused it"
            : "Email batch outcome unknown: Resend may have sent it",
          {
            subject: batch[0].subject,
            count: batch.length,
            name: error.name ?? null,
            statusCode: error.statusCode ?? null,
          },
        );
        if (definite) for (let i = start; i < start + batch.length; i++) notSent.push(i);
      } else if (permissive) {
        const errors = (data as { errors?: { index?: unknown }[] } | null)?.errors ?? [];
        let refused = 0;
        for (const e of errors) {
          if (typeof e?.index === "number" && Number.isInteger(e.index) && e.index >= 0 && e.index < batch.length) {
            invalid.push(start + e.index);
            refused += 1;
          }
        }
        if (refused > 0) {
          console.error("Email batch: Resend refused some addresses", { subject: batch[0].subject, count: refused });
        }
      }
    } catch (error) {
      console.error("Email batch outcome unknown: the send threw", { error });
    }
  }
  return { notSent, invalid };
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
    .select("title, author_id, pen_name_id, pd_work_id, pd_editor_credit")
    .eq("id", bookId)
    .single<{
      title: string;
      author_id: string;
      pen_name_id: string | null;
      pd_work_id?: string | null;
      pd_editor_credit?: boolean | null;
    }>();

  if (!book || book.author_id !== authorId || !book.pen_name_id) return;
  // BD15 P7: a public-domain edition without the editor mention never
  // names its uploader, so its pen name's followers get no email.
  if (book.pd_work_id && !book.pd_editor_credit) return;

  const [{ data: penName }, { data: follows }] = await Promise.all([
    admin
      .from("pen_names")
      .select("name")
      .eq("id", book.pen_name_id)
      .single<{ name: string }>(),
    admin.from("pen_name_follows").select("follower_id").eq("pen_name_id", book.pen_name_id),
  ]);

  if (!penName || !follows || follows.length === 0) return;

  // BD16 P5 (D2): a follower who also asked "Më njofto" for this book
  // gets only the pre-order release email, never this one too. Any row
  // of the current pre-order counts (sent or not); a row whose pre-order
  // was cancelled does not (that reader got the "cancelled" email and
  // did not ask again). An unreadable list sends to every follower.
  const waiting = new Set<string>();
  const { data: waiters, error: waitersError } = await admin
    .from("preorder_notify_requests")
    .select("user_id")
    .eq("book_id", bookId)
    .is("book_cancelled_at", null)
    .returns<{ user_id: string }[]>();
  if (waitersError) console.error("sendNewBookEmails: the pre-order readers read failed", { code: waitersError.code ?? null });
  for (const row of waiters ?? []) waiting.add(row.user_id);
  const recipients = follows.filter(({ follower_id: followerId }) => !waiting.has(followerId));
  if (recipients.length === 0) return;

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
  for (let start = 0; start < recipients.length; start += EMAIL_BATCH_SIZE) {
    const found = await Promise.all(
      recipients.slice(start, start + EMAIL_BATCH_SIZE).map(async ({ follower_id: followerId }) => {
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

// BD15 P5b-2: the changes a live book sent were approved; it stayed live.
export async function sendBookChangesApprovedEmail(to: string, { title, bookId }: { title: string; bookId: string }) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Ndryshimet e librit "${title}" u miratuan`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Ndryshimet e librit <strong>${escapeEmailHtml(title)}</strong> u miratuan</h1>
        <p>I kontrolluam dhe tani lexuesit shohin versionin e ri.</p>
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin tuaj</a></p>
      </div>`,
  );
}

// BD16 P3: Librum approved a pre-order listing; it shows in the Librari
// as coming out on its day. Readers can ask to be told.
export async function sendPreorderListedEmail(
  to: string,
  { title, bookId, releaseDate, hasFile }: { title: string; bookId: string; releaseDate: string; hasFile: boolean },
) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Parapublikimi i "${title}" u miratua`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Parapublikimi i <strong>${escapeEmailHtml(title)}</strong> u miratua</h1>
        <p>Libri tani shfaqet në Librari me datën e daljes ${escapeEmailHtml(formatDateOnly(releaseDate))}. Lexuesit mund të kërkojnë të njoftohen kur të dalë.</p>
        ${
          hasFile
            ? "<p>Dorëshkrimi final u miratua bashkë me parapublikimin, ndaj libri del vetë në datën e daljes.</p>"
            : "<p>Dorëshkrimi final duhet dërguar për shqyrtim të paktën 3 ditë para datës së daljes.</p>"
        }
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin tuaj</a></p>
      </div>`,
  );
}

// BD16 P3: Librum approved a pre-order's final manuscript before its
// day; the book comes out by itself on that day.
export async function sendPreorderFileApprovedEmail(
  to: string,
  { title, bookId, releaseDate }: { title: string; bookId: string; releaseDate: string },
) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Dorëshkrimi final i "${title}" u miratua`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Dorëshkrimi final i <strong>${escapeEmailHtml(title)}</strong> u miratua</h1>
        <p>Libri del vetë më ${escapeEmailHtml(formatDateOnly(releaseDate))}, rreth orës 08:00.</p>
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin tuaj</a></p>
      </div>`,
  );
}

// BD16 P5: the one email a reader who asked "Më njofto" gets (plan §1,
// Q4 a). Built here, sent in batches by src/lib/preorder-emails.ts.
// Only the title is named (escaped); the footer says it is the only one.
export function preorderReleasedReaderEmail({ title, bookId }: { title: string; bookId: string }) {
  const origin = resolveSiteOrigin();
  return {
    subject: `"${title}" doli në Librum`,
    html: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;"><strong>${escapeEmailHtml(title)}</strong> doli</h1>
        <p>Libri për të cilin kërkuat të njoftoheni sapo doli në Librari.</p>
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin</a></p>
        <p style="font-size: 12px; color: #666;">E morët këtë email sepse shtypët "Më njofto" për këtë libër. Është i vetmi email që do të merrni për të.</p>
      </div>`,
  };
}

// BD16 P5 (Renato 11-06, card: "Yes, one short new-date email"): the
// one allowed date move of a pre-order (the job's 30-day slip or the
// author's own push). Not the reader's one release email: that still
// comes when the book is out.
export function preorderDateMovedReaderEmail({
  title,
  bookId,
  releaseDate,
}: {
  title: string;
  bookId: string;
  releaseDate: string;
}) {
  const origin = resolveSiteOrigin();
  return {
    subject: `"${title}" del në një datë të re`,
    html: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;"><strong>${escapeEmailHtml(title)}</strong> del më ${escapeEmailHtml(formatDateOnly(releaseDate))}</h1>
        <p>Data e daljes së librit për të cilin kërkuat të njoftoheni u shty. Data e re është ${escapeEmailHtml(formatDateOnly(releaseDate))}.</p>
        <p>Do t'ju shkruajmë përsëri kur të dalë libri.</p>
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin</a></p>
        <p style="font-size: 12px; color: #666;">E morët këtë email sepse shtypët "Më njofto" për këtë libër. Që të mos merrni më, hapni faqen e librit dhe shtypni "Hiq njoftimin".</p>
      </div>`,
  };
}

// BD16 P5 (Q4 a): the pre-order ended before its day, for whatever
// reason (the author, a second missed deadline, Librum). The same
// neutral words every time: who or why is never said. The book page is
// gone, so the link is the Librari.
export function preorderCancelledReaderEmail({ title }: { title: string }) {
  const origin = resolveSiteOrigin();
  return {
    subject: `"${title}" nuk do të dalë në datën e njoftuar`,
    html: `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Parapublikimi i <strong>${escapeEmailHtml(title)}</strong> u anulua</h1>
        <p>Libri për të cilin kërkuat të njoftoheni nuk do të dalë në datën e njoftuar.</p>
        <p>Nëse njoftohet përsëri, hapni faqen e librit dhe shtypni përsëri "Më njofto".</p>
        <p><a href="${origin}/librari">Shikoni Librarinë</a></p>
        <p style="font-size: 12px; color: #666;">E morët këtë email sepse shtypët "Më njofto" për këtë libër. Nuk do të merrni email të tjerë për të.</p>
      </div>`,
  };
}

// BD16 P5: the author's emails from the daily job (plan §3.5). The
// author's own cancel and a staff takedown already tell the author, so
// these cover only what the job did by itself.
export async function sendPreorderReleasedAuthorEmail(to: string, { title, bookId }: { title: string; bookId: string }) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Libri juaj "${title}" doli sot në Librum`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Libri juaj <strong>${escapeEmailHtml(title)}</strong> doli sot</h1>
        <p>Erdhi data e daljes, ndaj parapublikimi u bë libër në Librari. Lexuesit që prisnin po marrin njoftimin e tyre.</p>
        <p><a href="${origin}/libra/${encodeURIComponent(bookId)}">Shikoni librin tuaj</a></p>
      </div>`,
  );
}

export async function sendPreorderDateMovedEmail(
  to: string,
  { title, releaseDate }: { title: string; releaseDate: string },
) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Data e daljes së "${title}" u shty me 30 ditë`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Data e daljes së <strong>${escapeEmailHtml(title)}</strong> u shty</h1>
        <p>Dorëshkrimi final nuk erdhi deri në afatin e tij, ndaj data e daljes u shty me 30 ditë, në ${escapeEmailHtml(formatDateOnly(releaseDate))}. Kjo ishte shtyrja e vetme e lejuar.</p>
        <p>Dërgojeni dorëshkrimin final për shqyrtim të paktën 3 ditë para datës së re. Nëse nuk vjen as këtë herë, parapublikimi anulohet.</p>
        <p><a href="${origin}/dashboard">Hapni panelin e autorit</a></p>
      </div>`,
  );
}

export async function sendPreorderCancelledAuthorEmail(to: string, { title }: { title: string }) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    `Parapublikimi i "${title}" u anulua`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Parapublikimi i <strong>${escapeEmailHtml(title)}</strong> u anulua</h1>
        <p>Dorëshkrimi final nuk erdhi as pas shtyrjes së datës, ndaj parapublikimi u anulua dhe libri u kthye në draft. Lexuesit që prisnin u njoftuan.</p>
        <p>Mund ta publikoni kur dorëshkrimi të jetë gati.</p>
        <p><a href="${origin}/dashboard">Hapni panelin e autorit</a></p>
      </div>`,
  );
}

export async function sendBookSentBackEmail(
  to: string,
  {
    title,
    reasonLabel,
    message,
    live = false,
  }: { title: string; reasonLabel: string; message: string; live?: boolean },
) {
  const origin = resolveSiteOrigin();
  await sendEmail(
    to,
    // BD15 P5b-3a (Renato 11-04): a live book's sent-back CHANGES -- the
    // book stays on sale, so the email names the changes, not the book.
    live ? `Librum jua ktheu ndryshimet e "${title}"` : `Librum jua ktheu "${title}" për ndryshime`,
    `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">${
          live
            ? `Librum jua ktheu ndryshimet e librit <strong>${escapeEmailHtml(title)}</strong>`
            : `Librum jua ktheu librin <strong>${escapeEmailHtml(title)}</strong> për ndryshime`
        }</h1>
        <p>Arsyeja: ${escapeEmailHtml(reasonLabel)}</p>
        <p>${escapeEmailHtmlWithBreaks(message)}</p>
        <p>${live ? LIVE_SENT_BACK_FIX_LINE : SENT_BACK_FIX_LINE}</p>${
          live ? "\n        <p>Libri juaj mbetet në shitje siç ishte para këtyre ndryshimeve.</p>" : ""
        }
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
