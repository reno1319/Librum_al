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
