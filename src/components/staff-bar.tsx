import Link from "next/link";
import { StaffPageLink } from "@/components/staff-page-link";

// Thin strip above the public header, shown only to staff (dashboard
// batch 1, b1q3 a). Visitors never see it. Same tab (b1q2 a).
const STAFF_BAR_LINK =
  "focus-ring inline-flex min-h-9 items-center rounded-sm font-medium text-primary-foreground underline-offset-4 hover:underline";

export function StaffBar({ canWritePosts, canViewBooks }: { canWritePosts: boolean; canViewBooks: boolean }) {
  return (
    <nav aria-label="Stafi" className="bg-[#111a16] text-sm text-primary-foreground">
      <div className="page-container flex min-h-9 items-center gap-6">
        <Link href="/admin" className={STAFF_BAR_LINK}>
          Administrimi
        </Link>
        {canWritePosts && (
          <Link href="/admin/blog/new" className={STAFF_BAR_LINK}>
            + Postim i ri
          </Link>
        )}
        <StaffPageLink canWritePosts={canWritePosts} canViewBooks={canViewBooks} className={STAFF_BAR_LINK} />
      </div>
    </nav>
  );
}
