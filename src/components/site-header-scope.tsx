"use client";

import { usePathname } from "next/navigation";
import { usesShopHeader } from "@/lib/header-bookstore";

// P2b (Renato 11-10 option a): the public layout has no pathname, so the
// server header renders both versions and this switch shows one of them:
// the new header (search + cream row) on Libraria and book pages, the
// header as it was before P2 everywhere else. Only usePathname (never
// the address's query: page-messages.sources.test.ts).
export function SiteHeaderScope({ shop, plain }: { shop: React.ReactNode; plain: React.ReactNode }) {
  const pathname = usePathname();
  return <>{usesShopHeader(pathname) ? shop : plain}</>;
}
