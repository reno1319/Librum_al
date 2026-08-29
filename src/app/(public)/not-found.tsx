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

// LIBRUM 2.0 404-1: the not-found surface for the public/product route
// tree -- both an unmatched path under this group and every dynamic
// public route's own notFound() call (Book Detail, Author pages, Bundle
// pages, etc.). Living inside src/app/(public)/ means it's wrapped by
// this group's own layout.tsx, so SiteHeader/SiteFooter still provide
// navigation exactly as before -- deliberately no Dashboard/Account/
// Login/Help/Contact links here, just the two recovery actions the
// brief calls for. A plain Server Component: no session/role check, no
// "use client", nothing that would make this page behave differently
// for a logged-out visitor, a reader, or an author.
//
// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: this file used
// to live at the app root and was, at the time, genuinely the one
// global not-found surface for the whole app (nothing under /admin/*
// called notFound() before ADMIN-1A). It moved here, alongside every
// other public route, when SiteHeader/SiteFooter moved out of the true
// root layout -- staying at the root would have meant losing them on
// every public 404, since a not-found.tsx boundary discards whatever
// layout it displaces (see this group's own layout.tsx comment). Two
// narrower, purpose-specific not-found files now cover what this one
// file used to: src/app/admin/not-found.tsx (admin's own 404s, e.g. a
// missing report/refund id, rendered inside AdminShell) and the true
// root src/app/not-found.tsx (a bare fallback for a URL that doesn't
// match /admin OR any public route at all -- rare, and correctly
// neutral rather than assuming either surface's chrome).
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
