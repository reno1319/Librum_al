import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import type { Metadata } from "next";

// LIBRUM 2.0 404-1: static metadata export. Route-level metadata
// resolution composes with the root layout's own title TEMPLATE
// ("%s | Librum", src/app/layout.tsx), so this alone is enough to
// produce "Page not found | Librum" -- no template string repeated
// here. notFound() itself already injects the noindex robots meta tag
// (see Next's own not-found docs), so nothing further is needed for
// that.
export const metadata: Metadata = {
  title: "Page not found",
};

// LIBRUM 2.0 404-1: the one global not-found surface for both unmatched
// URLs and every dynamic route's own notFound() call (Book Detail,
// Author pages, Bundle pages, etc. -- none of which are touched by this
// pass). Renders inside the root layout, so SiteHeader/SiteFooter
// already provide navigation -- deliberately no Dashboard/Account/
// Login/Help/Contact links here, just the two recovery actions the
// brief calls for. A plain Server Component: no session/role check, no
// "use client", nothing that would make this page behave differently
// for a logged-out visitor, a reader, or an author.
export default function NotFound() {
  return (
    <main className="relative flex w-full flex-1 items-center justify-center overflow-hidden px-4 py-24 sm:px-6">
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 flex select-none items-center justify-center font-serif text-[9rem] font-bold leading-none text-violet-tint sm:text-[13rem]"
      >
        404
      </span>
      <div className="relative mx-auto w-full max-w-md text-center">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">404</p>
        <h1 className="mt-2 font-serif text-3xl font-semibold text-foreground md:text-4xl">
          Page not found
        </h1>
        <p className="mt-3 text-muted">
          We couldn&apos;t find the page you&apos;re looking for.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <Link href="/" className={buttonClasses("primary", "md")}>
            Go home
          </Link>
          <Link
            href="/bookstore"
            className="focus-ring rounded-sm text-sm text-muted hover:underline"
          >
            Browse the Bookstore
          </Link>
        </div>
      </div>
    </main>
  );
}
