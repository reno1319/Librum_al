"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DismissableDetails } from "@/components/dismissable-details";
import {
  DASHBOARD_MENU_GROUPS,
  findDashboardMenuMatch,
  groupAriaCurrent,
  itemAriaCurrent,
} from "./dashboard-menu-items";

// FIX STEP F2: one menu above every /dashboard/* page, rendered by the
// dashboard layout. A client component because the layout does not
// re-render on client navigation, so the current page comes from
// usePathname(). Menu items are navigation, which the C1 underline rule
// excludes; the current group/item has non-colour cues (bold, brass bar).
export function DashboardMenu() {
  const pathname = usePathname() ?? "";
  const match = findDashboardMenuMatch(pathname);
  const subItems = match && match.group.items.length > 1 ? match.group.items : null;

  return (
    <nav aria-label="Paneli i autorit">
      {/* Computer and tablet: the four groups, then the current group's
          pages on a second line. */}
      <div className="hidden md:block">
        <ul className="flex gap-1 border-b border-border">
          {DASHBOARD_MENU_GROUPS.map((group) => {
            const current = match?.group === group;
            return (
              <li key={group.label}>
                <Link
                  href={group.items[0].href}
                  aria-current={groupAriaCurrent(group, match, pathname)}
                  className={`focus-ring -mb-px flex min-h-11 items-center whitespace-nowrap border-b-[3px] px-3 text-[0.9375rem] transition-colors ${
                    current
                      ? "border-accent font-bold text-primary"
                      : "border-transparent font-medium text-foreground hover:text-primary"
                  }`}
                >
                  {group.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {subItems && (
          <ul className="mt-1 flex gap-1">
            {subItems.map((item) => {
              const ariaCurrent = itemAriaCurrent(item, match, pathname);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={ariaCurrent}
                    className={`focus-ring flex min-h-11 items-center whitespace-nowrap rounded-control px-3 text-sm transition-colors ${
                      ariaCurrent
                        ? "font-bold text-primary"
                        : "font-medium text-muted hover:text-primary"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Phone: one "Section" control listing every page under its
          group. A <details> works without JavaScript; key={pathname}
          remounts it on client navigation, so it is closed on the new
          page. A tap outside or Escape also closes it (LEFTOVERS L1). */}
      <DismissableDetails key={pathname} className="group relative md:hidden">
        <summary className="focus-ring flex min-h-11 w-full cursor-pointer list-none items-center justify-between gap-2 rounded-control border border-control bg-surface px-3.5 text-[0.9375rem] text-foreground select-none [&::-webkit-details-marker]:hidden">
          <span>
            <span className="text-muted">Seksioni{match ? ":" : ""}</span>
            {match && (
              <>
                {" "}
                <span className="font-bold text-primary">{match.item.label}</span>
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
          {DASHBOARD_MENU_GROUPS.map((group, index) => {
            const labelId = `dashboard-menu-group-${index}`;
            return (
              <div key={group.label} className={index > 0 ? "mt-1 border-t border-border pt-1" : undefined}>
                <p id={labelId} className="px-3.5 pt-2 pb-1 text-xs font-bold tracking-[0.08em] text-muted uppercase">
                  {group.label}
                </p>
                <ul aria-labelledby={labelId}>
                  {group.items.map((item) => {
                    const ariaCurrent = itemAriaCurrent(item, match, pathname);
                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={ariaCurrent}
                          className={`focus-ring flex min-h-11 items-center border-l-[3px] px-3 text-[0.9375rem] ${
                            ariaCurrent
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
        </div>
      </DismissableDetails>
    </nav>
  );
}
