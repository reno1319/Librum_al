"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMenu, IconClose } from "@/components/icons";
import type { NavItem } from "@/components/nav-links";
import type { HeaderCta } from "@/components/site-header";
import { buttonClasses } from "@/components/ui/button";

// Mobile hamburger + collapsible panel. Isolated as its own client
// component (state: open/closed) so SiteHeader stays a server component.
// The logout server action is passed down as a prop rather than
// duplicated — same action the desktop header uses.
export function MobileNav({
  items,
  loggedIn,
  accountHref,
  logoutAction,
  recoveryActive = false,
  cta = null,
}: {
  items: NavItem[];
  loggedIn: boolean;
  accountHref: string;
  logoutAction: (formData: FormData) => void | Promise<void>;
  // LAUNCH-1 P2-5: takes precedence over loggedIn -- a recovery-
  // restricted session still has loggedIn=true (a real Supabase user
  // exists), but must never show ordinary authenticated nav, nor fall
  // back to the logged-out branch's Sign up link (also a dead end
  // during recovery; see the P2-5 audit's RECOVERY_ALLOWED_PATHS trace).
  recoveryActive?: boolean;
  // LIBRUM 2.0 UI-2: same HeaderCta shape buildSiteHeaderNav() produces
  // -- already null for both the reader and recovery states, so this
  // component doesn't need its own recovery-awareness for the CTA at
  // all, only to render it when present in the (non-recovery) branch.
  cta?: HeaderCta;
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

  const linkClassName = "focus-ring rounded-sm text-sm font-medium hover:underline";

  return (
    <div className="md:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
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
          className="absolute inset-x-0 top-full border-b border-border bg-surface px-4 py-4 shadow-md"
        >
          {recoveryActive ? (
            <div className="flex flex-col gap-3.5">
              <span className="text-sm text-muted">Password recovery</span>
              <form action={logoutAction}>
                <button type="submit" className={linkClassName}>
                  Log out
                </button>
              </form>
            </div>
          ) : (
            <>
              <nav className="flex flex-col gap-3.5">
                {items.map((item) => (
                  <Link key={item.href} href={item.href} className={linkClassName}>
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="mt-4 flex flex-col gap-3.5 border-t border-border pt-4">
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

                {cta && (
                  <Link
                    href={cta.href}
                    className={buttonClasses("primary", "sm", "mt-1 justify-center")}
                  >
                    {cta.label}
                  </Link>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
