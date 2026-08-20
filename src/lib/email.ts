import { Resend } from "resend";
import type { createAdminClient } from "@/lib/supabase/admin";

const FROM = process.env.EMAIL_FROM ?? "Librum <onboarding@resend.dev>";

// Notifications are a nice-to-have, not core functionality — never let a
// missing API key or a failed send break whatever triggered the email
// (here, recording a purchase). The Resend client is constructed lazily,
// inside the try block, since it throws immediately if no key is set.
async function sendEmail(to: string, subject: string, html: string) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(`RESEND_API_KEY not set — skipping email "${subject}" to ${to}`);
    return;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (error) {
    console.error("Failed to send email:", error);
  }
}

export async function sendPurchaseEmails(
  admin: ReturnType<typeof createAdminClient>,
  { bookId, readerId, amountCents }: { bookId: string; readerId: string; amountCents: number },
) {
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

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

  const amount = (amountCents / 100).toFixed(2);
  const bookUrl = `${origin}/books/${bookId}`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Your Librum purchase receipt",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Thanks for your purchase!</h1>
        <p>You bought <strong>${book.title}</strong> for $${amount}.</p>
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
        <p><strong>${book.title}</strong> just sold for $${amount}.</p>
        <p><a href="${origin}/dashboard/sales">View your sales</a></p>
      </div>`,
    );
  }
}

export async function sendBundlePurchaseEmails(
  admin: ReturnType<typeof createAdminClient>,
  { bundleId, readerId, amountCents }: { bundleId: string; readerId: string; amountCents: number },
) {
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

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

  const amount = (amountCents / 100).toFixed(2);
  const bundleUrl = `${origin}/bundles/${bundleId}`;

  if (reader?.user?.email) {
    await sendEmail(
      reader.user.email,
      "Your Librum purchase receipt",
      `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
        <h1 style="font-size: 20px;">Thanks for your purchase!</h1>
        <p>You bought the <strong>${bundle.title}</strong> bundle for $${amount}.</p>
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
        <p>Your <strong>${bundle.title}</strong> bundle just sold for $${amount}.</p>
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
  }: {
    bundleId: string | null;
    bundleTitle: string;
    authorId: string | null;
    readerId: string;
    amountCents: number;
  },
) {
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const [{ data: reader }, { data: author }] = await Promise.all([
    admin.auth.admin.getUserById(readerId),
    authorId
      ? admin.auth.admin.getUserById(authorId)
      : Promise.resolve({ data: { user: null }, error: null }),
  ]);

  const amount = (amountCents / 100).toFixed(2);
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
        <p>You bought the <strong>${bundleTitle}</strong> bundle for $${amount}.</p>
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
        <p>Your <strong>${bundleTitle}</strong> bundle just sold for $${amount}.</p>
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
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

  const [{ data: book }, { data: author }, { data: follows }] = await Promise.all([
    admin.from("books").select("title").eq("id", bookId).single(),
    admin.from("profiles").select("display_name").eq("id", authorId).single(),
    admin.from("author_follows").select("follower_id").eq("author_id", authorId),
  ]);

  if (!book || !author || !follows || follows.length === 0) return;

  const bookUrl = `${origin}/books/${bookId}`;

  await Promise.all(
    follows.map(async ({ follower_id: followerId }) => {
      const { data: follower } = await admin.auth.admin.getUserById(followerId);
      if (!follower?.user?.email) return;

      await sendEmail(
        follower.user.email,
        `${author.display_name} just published a new book`,
        `<div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h1 style="font-size: 20px;">New from ${author.display_name}</h1>
          <p><strong>${book.title}</strong> just went live.</p>
          <p><a href="${bookUrl}">View the book</a></p>
        </div>`,
      );
    }),
  );
}
