import { createClient } from "@/lib/supabase/server";
import { resolveAuthorPageCta, type HomepageCta } from "@/lib/homepage";

// AUTHOR PAGES REDESIGN: the visitor's closing-band button for the inner
// author pages, read per request -- the same user + profile role read
// the home page does, decided by resolveAuthorPageCta().
export async function getAuthorPageCta(): Promise<HomepageCta | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let role: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    role = profile?.role ?? null;
  }

  return resolveAuthorPageCta({ user: user ? { id: user.id } : null, role });
}
