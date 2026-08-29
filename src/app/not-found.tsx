import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import type { Metadata } from "next";

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: this is now
// ONLY the fallback for a URL that doesn't match /admin/* or any
// public route at all -- src/app/(public)/not-found.tsx (the original,
// richer 404 that used to live here) covers every unmatched path under
// the public route tree and every public page's own notFound() call;
// src/app/admin/not-found.tsx covers the admin tree. Reaching this
// file specifically means neither segment matched even partially (e.g.
// a mistyped domain-relative path with no recognizable prefix at all),
// which is rare in practice.
//
// Deliberately bare: it renders directly inside the true root layout
// (src/app/layout.tsx), which no longer includes SiteHeader/SiteFooter,
// and it would be wrong to assume either the public site's or the
// admin back-office's chrome for a path that matched neither -- just
// the one universally-safe recovery action, styled with the shared
// buttonClasses() helper (a plain style utility, not tied to
// SiteHeader/any per-request data, so reusing it here carries none of
// global-error.tsx's own reason to avoid shared imports).
export const metadata: Metadata = {
  title: "Page not found",
};

export default function NotFound() {
  return (
    <main className="flex w-full flex-1 items-center justify-center px-4 py-24 sm:px-6">
      <div className="mx-auto w-full max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">404</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold text-foreground md:text-4xl">
          Page not found
        </h1>
        <p className="mt-3 text-muted">
          We couldn&apos;t find the page you&apos;re looking for.
        </p>
        <div className="mt-8">
          <Link href="/" className={buttonClasses("primary", "md")}>
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
