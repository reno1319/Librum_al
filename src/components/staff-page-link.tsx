"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { resolveStaffPageLink } from "@/lib/staff-page-link";

// The staff bar sits in the shared header, which can't see the page's
// own data, so the link is worked out from the address (batch 2).
export function StaffPageLink({
  canWritePosts,
  canViewBooks,
  className,
}: {
  canWritePosts: boolean;
  canViewBooks: boolean;
  className: string;
}) {
  const pathname = usePathname() ?? "";
  const link = resolveStaffPageLink(pathname, { canWritePosts, canViewBooks });
  if (!link) return null;
  return (
    <Link href={link.href} className={className}>
      {link.label}
    </Link>
  );
}
