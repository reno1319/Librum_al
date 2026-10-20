"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DismissableDetails } from "@/components/dismissable-details";
import { findCurrentAdminNavItem, isAdminNavItemCurrent, type AdminNavGroup } from "./admin-nav";

// ADMIN-1 (A2 look): the phone menu (below md) is one "Section ▾"
// control, replacing the earlier ☰ drawer. Same markup pattern as the
// phone dashboard menu (src/app/(public)/dashboard/dashboard-menu.tsx):
// a <details> works without JavaScript; key={pathname} remounts it on
// client navigation, so it is closed on the new page; DismissableDetails
// also closes it on a tap outside and on Escape. It lists the same
// groups as the desktop sidebar, then Log out, so Log out stays
// reachable on a phone.
export function AdminMobileNav({
  groups,
  logoutAction,
}: {
  groups: readonly AdminNavGroup[];
  logoutAction: (formData: FormData) => void | Promise<void>;
}) {
  const pathname = usePathname() ?? "";
  const current = findCurrentAdminNavItem(pathname, groups);

  return (
    <nav aria-label="Admin" className="md:hidden">
      <DismissableDetails key={pathname} className="group relative">
        <summary className="focus-ring flex min-h-12 w-full cursor-pointer list-none items-center justify-between gap-2 rounded-control border border-control bg-surface px-3.5 text-base text-foreground select-none [&::-webkit-details-marker]:hidden">
          <span>
            <span className="text-muted">Section{current ? ":" : ""}</span>
            {current && (
              <>
                {" "}
                <span className="font-bold text-primary">{current.label}</span>
              </>
            )}
          </span>
          <span
            aria-hidden="true"
            className="text-muted transition-transform group-open:rotate-180 motion-reduce:transition-none"
          >
            ▾
          </span>
        </summary>
        <div className="absolute inset-x-0 z-10 mt-1 rounded-control border border-border bg-surface py-2 shadow-md">
          {groups.map((group, index) => {
            const labelId = `admin-menu-group-${index}`;
            return (
              <div key={group.label} className={index > 0 ? "mt-1 border-t border-border pt-1" : undefined}>
                <p
                  id={labelId}
                  className="px-3.5 pt-2 pb-1 text-xs font-semibold tracking-[0.12em] text-[#806510] uppercase"
                >
                  {group.label}
                </p>
                <ul aria-labelledby={labelId}>
                  {group.items.map((item) => {
                    const isCurrent = isAdminNavItemCurrent(pathname, item.href);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={isCurrent ? "page" : undefined}
                          className={`focus-ring flex min-h-11 items-center border-l-[3px] px-3 text-base ${
                            isCurrent
                              ? "border-accent bg-surface-hover font-bold text-primary"
                              : "border-transparent font-medium text-foreground hover:bg-surface-hover"
                          }`}
                        >
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
          <form action={logoutAction} className="mt-1 border-t border-border pt-1">
            <button
              type="submit"
              className="focus-ring flex min-h-11 w-full items-center border-l-[3px] border-transparent px-3 text-left text-base font-medium text-foreground hover:bg-surface-hover"
            >
              Log out
            </button>
          </form>
        </div>
      </DismissableDetails>
    </nav>
  );
}
