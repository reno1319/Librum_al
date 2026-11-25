import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { pageErrorMessage } from "@/lib/page-messages";
import type { GiftStatus } from "@/lib/gifts";
import { changeGiftEmail } from "../../../dhurata/actions";

// GIFTS (item 32 batch 2, g2 a / g3 a / b2q3 a): the buyer fixes a gift's
// email, or sends it to someone else when the friend already owns the
// book. The same look as the Dhuroje form (pictures r2), email only. A new
// email sends a new link and starts a new count of 3.
export const metadata: Metadata = {
  title: "Ndrysho emailin e dhuratës",
  robots: { index: false },
};

const FIELD = "focus-ring mt-1 w-full rounded-[8px] border border-[#8c8472] bg-surface px-3 py-2.5 text-base";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ChangeGiftEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  const { error: rawError } = await searchParams;
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(`/library/dhurata/${id}`)}`);

  const { data: gift } = await supabase
    .from("gifts")
    .select("id, book_id, recipient_email, status")
    .eq("id", id)
    .maybeSingle<{ id: string; book_id: string; recipient_email: string; status: GiftStatus }>();
  if (!gift) notFound();
  if (gift.status === "claimed") redirect("/library#dhuratat");

  const { data: book } = await supabase
    .from("public_books")
    .select("title")
    .eq("id", gift.book_id)
    .maybeSingle<{ title: string }>();
  const error = pageErrorMessage(rawError);
  const elsewhere = gift.status === "recipient_owns";

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <div className="mx-auto max-w-xl">
        <h1 className="font-serif text-2xl text-foreground md:text-4xl">
          {elsewhere ? "Dërgoje te dikush tjetër" : "Ndrysho emailin"}
        </h1>
        <p className="mt-2 text-muted break-words">
          {book?.title ?? "Libri"} · tani për {gift.recipient_email}
        </p>
        {error && (
          <Alert variant="error" className="mt-4">
            {error}
          </Alert>
        )}
        <form action={changeGiftEmail.bind(null, gift.id)} className="mt-8 flex flex-col gap-5">
          <label htmlFor="gift-email" className="block text-sm font-medium">
            Emaili i personit që e merr
            <input id="gift-email" name="email" type="email" required maxLength={254} autoComplete="off" className={FIELD} />
            <span className="mt-1 block font-normal text-muted">
              I dërgojmë një email me një link të ri. Linku i vjetër nuk vlen më.
            </span>
          </label>
          <button type="submit" className={buttonClasses("primary", "lg", "w-full")}>
            Dërgoje dhuratën
          </button>
          <Link
            href="/library#dhuratat"
            className="focus-ring flex min-h-11 items-center justify-center text-sm text-primary underline underline-offset-2"
          >
            Anulo
          </Link>
        </form>
      </div>
    </main>
  );
}
