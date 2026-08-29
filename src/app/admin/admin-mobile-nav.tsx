"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMenu, IconClose } from "@/components/icons";
import type { AdminNavItem } from "./admin-nav";

// ADMIN-1A.5: compact responsive nav for the admin shell on small
// screens -- same structure/behavior as src/components/mobile-nav.tsx
// (isolated client component purely for open/closed state, so
// AdminShell itself stays a Server Component; close-on-navigate handled
// during render per React's own guidance rather than in a useEffect;
// Escape-to-close). Deliberately simpler than that component: no
// recovery-session branch (the admin shell only ever renders for an
// already-authenticated, already-authorized staff member -- a recovery-
// restricted session never reaches here at all, since /admin/login isn't
// on RECOVERY_ALLOWED_PATHS and every other /admin/* page redirects to
// /reset-password before this shell would ever mount), and no logged-out
// branch (same reason).
export function AdminMobileNav({
  items,
  logoutAction,
}: {
  items: AdminNavItem[];
  logoutAction: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelId = useId();

  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const linkClassName = "focus-ring rounded-sm text-sm font-medium hover:underline";

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close admin navigation" : "Open admin navigation"}
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex size-11 items-center justify-center rounded-sm text-foreground"
      >
        <span aria-hidden="true">
          {open ? <IconClose className="size-6" /> : <IconMenu className="size-6" />}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-10 border-b border-border bg-surface px-4 py-4 shadow-md"
        >
          <nav className="flex flex-col gap-3.5" aria-label="Admin">
            {items.map((item) => (
              <Link key={item.href} href={item.href} className={linkClassName}>
                {item.label}
              </Link>
            ))}
          </nav>

          <div className="mt-4 flex flex-col gap-3.5 border-t border-border pt-4">
            <form action={logoutAction}>
              <button type="submit" className={linkClassName}>
                Sign out
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
