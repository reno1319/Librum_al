"use client";

import { useEffect } from "react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-1: the root App Router error boundary --
// confirmed absent before this pass (no error.tsx/global-error.tsx
// anywhere in src/app, per the ROADMAP-1 audit). Without this file, ANY
// uncaught exception thrown while rendering a Server or Client
// Component under the root layout -- not just this one page -- fell
// through to Next's own default crash screen: unbranded, no
// navigation, and in production only a bare "Application error:
// a server-side exception has occurred (Digest: ...)" line.
//
// Must be a Client Component -- this is a Next.js requirement for
// error.tsx, not a stylistic choice (it receives `error` and `reset`
// as props and needs client-side interactivity for the Retry button).
// Deliberately renders inside the root layout's own <body>, so
// SiteHeader/SiteFooter are still present -- same reasoning as
// not-found.tsx, which takes the identical approach for the 404 case.
// This intentionally does NOT catch errors thrown BY SiteHeader/
// SiteFooter/RootLayout itself -- see global-error.tsx and this
// pass's own report for that decision.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Logged for operator visibility only -- never rendered. No raw
  // stack trace or digest is shown to the visitor; see the ERR-2
  // correction in this same pass for the identical "log server-side,
  // show a stable message" posture applied to Server Action errors.
  useEffect(() => {
    console.error("Root error boundary caught:", error);
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
