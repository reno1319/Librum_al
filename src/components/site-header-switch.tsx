"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isStoreHeaderPath } from "@/lib/store-header-paths";

// HEADER FIX (Renato 11-27, hd1 a): the (public) layout is shared by
// every page and is not drawn again when you move between pages inside
// the site, so a header chosen there once stayed on the next page (the
// shop header on the homepage after tapping the logo, the normal header
// on Libraria when arriving from the homepage). SiteHeader now draws
// both headers on the server and this picks one from the browser's
// current path, which updates on every move. Only the chosen one is put
// on the page.
export function SiteHeaderSwitch({ store, normal }: { store: ReactNode; normal: ReactNode }) {
  const pathname = usePathname();
  return <>{isStoreHeaderPath(pathname) ? store : normal}</>;
}
