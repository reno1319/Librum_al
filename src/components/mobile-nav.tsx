"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMenu, IconClose } from "@/components/icons";
import type { NavItem } from "@/components/nav-links";

// Mobile hamburger + collapsible panel. Isolated as its own client
// component (state: open/closed) so SiteHeader stays a server component.
// The logout server action is passed down as a prop rather than
// duplicated — same action the desktop header uses.
export function MobileNav({
  items,
  loggedIn,
  accountHref,
  logoutAction,
}: {
  items: NavItem[];
  loggedIn: boolean;
  accountHref: string;
  logoutAction: (formData: FormData) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelId = useId();

  // Close whenever a navigation actually happens. Adjusting state during
  // render (comparing against the last-seen pathname) rather than in a
  // useEffect, per React's guidance for resetting state on a prop change.
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

  const linkClassName = "text-sm font-medium hover:underline";

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-center text-foreground"
        style={{ width: "2.75rem", height: "2.75rem" }}
      >
        <span aria-hidden="true">
          {open ? (
            <IconClose style={{ width: "1.5rem", height: "1.5rem" }} />
          ) : (
            <IconMenu style={{ width: "1.5rem", height: "1.5rem" }} />
          )}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full border-b border-border bg-surface px-4 py-4 shadow-sm"
        >
          <nav
            style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}
          >
            {items.map((item) => (
              <Link key={item.href} href={item.href} className={linkClassName}>
                {item.label}
              </Link>
            ))}
          </nav>

          <div
            className="mt-4 border-t border-border pt-4"
            style={{ display: "flex", flexDirection: "column", gap: "0.875rem" }}
          >
            {loggedIn ? (
              <>
                <Link href={accountHref} className={linkClassName}>
                  Account
                </Link>
                <form action={logoutAction}>
                  <button type="submit" className={linkClassName}>
                    Log out
                  </button>
                </form>
              </>
            ) : (
              <>
                <Link href="/login" className={linkClassName}>
                  Log in
                </Link>
                <Link href="/signup" className={linkClassName}>
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
