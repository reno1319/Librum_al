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
//
// REDESIGN STEP 2: `onDark` is for the public site header's dark green
// bar, where the default active colour (text-primary) would be invisible.
// On dark the current page keeps aria-current plus two non-colour cues
// (semibold weight and a brass underline bar); other links take a thin
// cream underline on hover. Admin callers omit it and are unchanged.
export function NavLinks({
  items,
  className,
  onDark = false,
}: {
  items: NavItem[];
  className?: string;
  onDark?: boolean;
}) {
  const pathname = usePathname();

  return (
    <>
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        const stateClassName = onDark
          ? active
            ? "font-semibold text-primary-foreground underline decoration-accent decoration-2 underline-offset-8"
            : "text-primary-foreground/85 underline-offset-8 transition-colors hover:text-primary-foreground hover:underline"
          : active
            ? "font-semibold text-primary"
            : "transition-colors hover:underline";
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={
              className
                ? `${className} focus-ring rounded-sm ${stateClassName}`
                : `focus-ring rounded-sm ${stateClassName}`
            }
          >
            {item.label}
          </Link>
        );
      })}
    </>
  );
}
