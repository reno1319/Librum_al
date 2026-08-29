import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import type { Metadata } from "next";

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION, updated again by
// the FINAL ROUTING INVARIANT CORRECTION: lives inside admin/(protected)/
// alongside every other protected admin page, so it catches notFound()
// calls from any of them (currently src/app/admin/(protected)/reports/
// [id]/page.tsx and .../refunds/[id]/page.tsx, for a missing/
// inaccessible report or refund id) without falling through to the
// app's true root not-found.tsx. Per Next's own not-found.js component
// hierarchy, this file renders wrapped by ITS OWN segment's layout --
// admin/(protected)/layout.tsx -- exactly like every other protected
// admin page, so an authenticated staff member still sees AdminShell
// (nav, identity, sign out) around this content, never the public
// SiteHeader/SiteFooter and never a bare unstyled fallback. Moving it
// inside (protected) (rather than leaving it at the outer admin/ level)
// is what makes that AdminShell wrapping automatic again now that
// admin/layout.tsx itself no longer does any staff-gating of its own --
// see that file's own comment. Before ADMIN-1A introduced these two
// notFound() calls, nothing under /admin/* ever threw one, so this file
// did not need to exist yet.
export const metadata: Metadata = {
  title: "Not found",
};

export default function AdminNotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center px-4 text-center">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-foreground">Not found</h1>
      <p className="mt-3 text-muted">
        This item doesn&apos;t exist, or you no longer have access to it.
      </p>
      <Link href="/admin" className={`mt-8 ${buttonClasses("primary", "md")}`}>
        Back to Dashboard
      </Link>
    </div>
  );
}
