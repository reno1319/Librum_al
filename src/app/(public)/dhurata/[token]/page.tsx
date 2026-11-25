import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { resolveBookByline } from "@/lib/book-byline";
import { GIFT_TOKEN, type GiftStatus } from "@/lib/gifts";
import { pageErrorMessage } from "@/lib/page-messages";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import { claimGift } from "../actions";

// GIFTS (Renato 2026-11-25, item 32 batch 2; pictures r2 + b2 r1 ok): the
// page the gift email links to. Signed out: sign in or create an account
// (g1 a). Signed in: one button, the first reader with the link gets the
// book (b2q4 a). If they already own it, they are told and the buyer can
// send it to someone else (g3 a).
export const metadata: Metadata = {
  title: "Një dhuratë për ju",
  robots: { index: false },
};

type Preview = { book_id: string; buyer_name: string; note: string | null; status: GiftStatus };

export default async function GiftClaimPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string; "e-keni"?: string }>;
}) {
  const { token } = await params;
  const { error: rawError, "e-keni": ownedFlag } = await searchParams;
  const supabase = await createClient();

  let preview: Preview | null = null;
  if (GIFT_TOKEN.test(token)) {
    const { data } = await supabase.rpc("gift_preview", { p_token: token }).maybeSingle<Preview>();
    preview = data ?? null;
  }

  if (!preview) {
    return (
      <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
        <div className="mx-auto max-w-md text-center">
          <h1 className="font-serif text-2xl text-foreground md:text-4xl">Ky link nuk vlen më</h1>
          <p className="mt-3 text-muted">Nëse dikush ju dhuroi një libër, kërkojini ta dërgojë dhuratën përsëri.</p>
          <Link href="/librari" className={buttonClasses("secondary", "lg", "mt-6")}>
            Shfletoni Librarinë
          </Link>
        </div>
      </main>
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data: book } = await supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .eq("id", preview.book_id)
    .maybeSingle<PublicBook & { pen: PenNameRef | null }>();
  const coverUrl = book?.cover_path ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl : null;
  const error = pageErrorMessage(rawError);
  const buyer = preview.buyer_name;
  const owned = preview.status === "recipient_owns" && ownedFlag === "1";
  const next = encodeURIComponent(`/dhurata/${token}`);

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <div className="mx-auto flex max-w-md flex-col items-center text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Një dhuratë për ju</p>
        <h1 className="mt-2 font-serif text-2xl text-foreground md:text-4xl">{buyer} ju dhuroi një libër</h1>
        {error && (
          <Alert variant="error" className="mt-4 w-full text-left">
            {error}
          </Alert>
        )}
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt="" className="mt-6 h-56 w-36 rounded-[3px] object-cover shadow-md" />
        ) : (
          <div aria-hidden="true" className="mt-6 h-56 w-36 rounded-[3px] bg-surface-hover" />
        )}
        {book && (
          <>
            <p className="mt-4 font-serif text-xl break-words">{book.title}</p>
            <p className="text-sm text-muted">nga {resolveBookByline(book)}</p>
          </>
        )}
        {preview.note && (
          <blockquote className="mt-5 w-full rounded-[8px] bg-surface-hover px-4 py-3 text-left break-words">
            “{preview.note}”<span className="mt-1 block text-sm text-muted">{buyer}</span>
          </blockquote>
        )}
        {preview.status === "claimed" ? (
          <div className="mt-6 w-full rounded-[8px] border border-border bg-surface p-4 text-left text-sm">
            <p className="font-medium">Kjo dhuratë është marrë tashmë.</p>
          </div>
        ) : owned ? (
          <div className="mt-6 w-full rounded-[8px] border border-border bg-surface p-4 text-left text-sm">
            <p className="font-medium">E keni tashmë këtë libër.</p>
            <p className="mt-1 text-muted">
              {/* The picture said "Anës": a name can't be put in the dative case for every name, so "dërguesit". */}
              I treguam dërguesit, që ta dërgojë dhuratën te dikush tjetër. Libri juaj mbetet në Bibliotekë.
            </p>
          </div>
        ) : user ? (
          <form action={claimGift.bind(null, token)} className="mt-6 flex w-full flex-col gap-2">
            <button type="submit" className={buttonClasses("primary", "lg", "w-full")}>
              Merre dhuratën
            </button>
            <p className="mt-1 text-sm text-muted">Libri shkon në Bibliotekën tuaj.</p>
          </form>
        ) : (
          <div className="mt-6 flex w-full flex-col gap-2">
            <Link href={`/login?next=${next}`} className={buttonClasses("primary", "lg", "w-full")}>
              Hyr për ta marrë
            </Link>
            <Link href="/signup" className={buttonClasses("secondary", "lg", "w-full")}>
              Krijo një llogari falas
            </Link>
            <p className="mt-1 text-sm text-muted">Libri shkon në Bibliotekën tuaj sapo të hyni.</p>
          </div>
        )}
      </div>
    </main>
  );
}
