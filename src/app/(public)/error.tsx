"use client";

import { useEffect } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: scoped to the
// public/product route tree, alongside every route now nested under
// src/app/(public)/. Catches both an error thrown by any public page
// AND a failure inside this group's own layout.tsx -- most notably
// SiteHeader's per-request supabase.auth.getUser() call (see that
// layout's own comment) -- since this file's boundary sits directly
// below that layout, not above it. That's a strict improvement over
// the original single root error.tsx (src/app/error.tsx), which could
// never catch a SiteHeader failure at all (SiteHeader sat as a SIBLING
// of that boundary's own wrapped {children}, not a descendant of it) --
// see global-error.tsx for why that gap existed and still exists for
// the true root layout itself.
//
// Must be a Client Component -- a Next.js requirement for error.tsx.
// Content is intentionally identical to the original src/app/error.tsx
// this was derived from: same recovery UI, just relocated so it's
// nested inside this group's layout and keeps SiteHeader/SiteFooter
// through ordinary layout inheritance, exactly as it did before this
// correction.
export default function PublicError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Logged for operator visibility only -- never rendered. No raw
  // stack trace or digest is shown to the visitor.
  useEffect(() => {
    console.error("Public route error boundary caught:", error);
  }, [error]);

  return (
    <main className="flex w-full flex-1 items-center justify-center px-4 py-24 sm:px-6">
      <div className="mx-auto w-full max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Error</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold text-foreground md:text-4xl">
          Something went wrong
        </h1>
        <p className="mt-3 text-muted">
          We couldn&apos;t load this page. Please try again.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className={buttonClasses("primary", "md")}
          >
            Try again
          </button>
          <Link href="/" className="focus-ring rounded-sm text-sm text-muted hover:underline">
            Go home
          </Link>
        </div>
      </div>
    </main>
  );
}
