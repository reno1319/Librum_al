"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isAdminNavItemCurrent, type AdminNavGroup } from "./admin-nav";

// ADMIN-1 (A2 look): the desktop sidebar (md and up). White, one gold
// eyebrow per group, the current page a filled dark-green row. A client
// component only because the current page comes from usePathname(): the
// admin layout does not re-render on client navigation. Brass is never
// text on white here; the eyebrows use the darkened gold #806510, as
// bookstore/page.tsx does.
export function AdminSidebarNav({ groups }: { groups: readonly AdminNavGroup[] }) {
  const pathname = usePathname() ?? "";

  return (
    <nav aria-label="Admin" className="flex flex-col">
      {groups.map((group, index) => {
        const labelId = `admin-nav-group-${index}`;
        return (
          <div key={group.label} className={index > 0 ? "mt-5" : undefined}>
            <p
              id={labelId}
              className="px-3 pb-1.5 text-xs font-semibold tracking-[0.12em] text-[#806510] uppercase"
            >
              {group.label}
            </p>
            <ul aria-labelledby={labelId} className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const current = isAdminNavItemCurrent(pathname, item.href);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={current ? "page" : undefined}
                      className={`focus-ring flex min-h-11 items-center rounded-control px-3 text-[0.9375rem] transition-colors ${
                        current
                          ? "bg-primary font-semibold text-primary-foreground"
                          : "font-medium text-primary hover:bg-surface-hover"
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
    </nav>
  );
}
