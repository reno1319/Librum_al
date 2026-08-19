"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type NavItem = { href: string; label: string };

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  if (href === "/dashboard") {
    return pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  }
  return pathname === href;
}

// Desktop nav links only — isolated as a client component purely because
// active-state needs the current pathname (usePathname). SiteHeader itself
// stays a server component; this is the smallest piece that needs to be
// client-side.
export function NavLinks({
  items,
  className,
}: {
  items: NavItem[];
  className?: string;
}) {
  const pathname = usePathname();

  return (
    <>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              className
                ? `${className} ${active ? "font-semibold text-primary" : "hover:underline"}`
                : active
                  ? "font-semibold text-primary"
                  : "hover:underline"
            }
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
