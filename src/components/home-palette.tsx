"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";

// HOMEPAGE-2 (Renato 2026-11-19, "Homepage only"): the homepage's dark
// blue header and footer, gold and outline buttons and light link bar
// show on the homepage only; every other page keeps the green look. The
// header and footer are shared, so the few places that differ ask here
// whether this is the homepage. usePathname is known on the server
// render too, so the first paint is already right.
export function useIsHomePage(): boolean {
  return usePathname() === "/";
}

/** Renders `home` on the homepage and `other` on every other page. */
export function ByPage({ home, other }: { home: ReactNode; other: ReactNode }) {
  return useIsHomePage() ? home : other;
}

/** One element whose class depends on the page; the children are shared. */
export function PageClass({
  as: Tag,
  home,
  other,
  "aria-label": ariaLabel,
  children,
}: {
  as: "header" | "footer" | "div" | "nav";
  home: string;
  other: string;
  /** Names a nav landmark (e.g. "Llogaria") on every page. */
  "aria-label"?: string;
  children: ReactNode;
}) {
  return (
    <Tag className={useIsHomePage() ? home : other} aria-label={ariaLabel}>
      {children}
    </Tag>
  );
}
