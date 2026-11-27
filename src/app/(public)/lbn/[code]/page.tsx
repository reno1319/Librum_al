import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { NOT_FOUND_METADATA } from "@/lib/seo";
import { normalizeLbn } from "@/lib/lbn";
import { createClient } from "@/lib/supabase/server";

// LBN (lbnq9 a): librum.al/lbn/<LBN> opens that book's normal page, like
// amazon.com/dp/<ASIN>. Small letters work too. Only a book that is live
// (published or on pre-order) is found: a draft, an unpublished or a
// deleted book shows the usual "not found" page, so the link never
// reveals a book that is not out. A code with a wrong check character
// is not looked up at all.

export const dynamic = "force-dynamic";

// S2 (pb1 a): this page only ever redirects or answers notFound(), so
// its own title is the not-found one (else the tab flips to the site
// title after loading).
export const metadata: Metadata = NOT_FOUND_METADATA;

export default async function LbnPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let raw: string;
  try {
    raw = decodeURIComponent(code);
  } catch {
    notFound();
  }
  const lbn = normalizeLbn(raw);
  if (!lbn) notFound();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_books")
    .select("id")
    .eq("lbn", lbn)
    .in("status", ["published", "preorder"])
    .maybeSingle<{ id: string }>();
  if (error || !data || typeof data.id !== "string") notFound();

  redirect(`/libra/${data.id}`);
}
