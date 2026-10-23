"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconMenu, IconClose } from "@/components/icons";
import type { NavItem } from "@/components/nav-links";

// PHONE PASS (D5): the parts of a document attachOutsideTap uses (a
// fake in tests; vitest runs in node with no DOM).
export type OutsideTapDocument = Pick<Document, "addEventListener" | "removeEventListener">;

/**
 * While the menu is open: a pointerdown outside `root` (the ☰ button and
 * its panel) calls `close`. A tap on the button itself is inside, so its
 * own click still toggles. Returns the cleanup that removes the listener.
 */
export function attachOutsideTap(
  root: Pick<Node, "contains">,
  doc: OutsideTapDocument,
  close: () => void,
): () => void {
  function onPointerDown(event: Event) {
    if (!root.contains(event.target as Node | null)) close();
  }
  doc.addEventListener("pointerdown", onPointerDown);
  return () => doc.removeEventListener("pointerdown", onPointerDown);
}

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
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

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
    const detachOutsideTap = rootRef.current
      ? attachOutsideTap(rootRef.current, document, () => setOpen(false))
      : () => {};
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      detachOutsideTap();
    };
  }, [open]);

  // REDESIGN STEP 2: the open panel continues the header's dark green
  // bar, so links are cream (11.1:1 on green). Menu items, not inline
  // text links, so they underline on hover only.
  // PHONE PASS r2 (audit N2): each link and button is a 44px tap
  // target; the lists lose their gap, so the spacing stays about the same.
  const linkClassName =
    "focus-ring flex min-h-11 items-center rounded-sm text-base font-medium text-primary-foreground hover:underline";

  return (
    <div ref={rootRef} className="lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="focus-ring flex size-11 items-center justify-center rounded-sm text-primary-foreground"
      >
        <span aria-hidden="true">
          {open ? <IconClose className="size-6" /> : <IconMenu className="size-6" />}
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="absolute inset-x-0 top-full z-20 border-t border-primary-foreground/15 bg-primary px-4 py-4 shadow-md sm:px-6"
        >
          {recoveryActive ? (
            <div className="flex flex-col">
              <span className="text-sm text-primary-foreground/80">Password recovery</span>
              <form action={logoutAction}>
                <button type="submit" className={linkClassName}>
                  Log out
                </button>
              </form>
            </div>
          ) : (
            <>
              <nav className="flex flex-col">
                {items.map((item) => (
                  <Link key={item.href} href={item.href} className={linkClassName}>
                    {item.label}
                  </Link>
                ))}
              </nav>

              <div className="mt-4 flex flex-col border-t border-primary-foreground/15 pt-4">
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
                    {/* FIX1 (X2): Author chosen, as on Earnings. */}
                    <Link href="/signup?role=author" className={linkClassName}>
                      Sign up
                    </Link>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
