import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: SiteHeader/
// SiteFooter used to live directly in the true root layout
// (src/app/layout.tsx), which meant EVERY route -- public and
// /admin/* alike -- inherited them unconditionally. That's what this
// route group fixes: every existing public/product route moved here
// (about, account, auth, authors, books, bookstore, bundles, contact,
// dashboard, following, forgot-password, help, how-it-works, library,
// login, pricing, privacy, reset-password, series, signup, terms,
// wishlist, plus the homepage) so SiteHeader/SiteFooter apply to
// exactly that set, structurally, via normal layout nesting -- not a
// pathname check, not CSS, not a second copy of either component.
// `/admin/*` sits OUTSIDE this group (a real segment, not a group), so
// it never nests inside this layout and never inherits these two
// components at all.
//
// A route group's folder name (the parenthesized "(public)") is not
// part of the URL, so every route below keeps its exact existing path
// -- this is purely a component-tree change, not a URL change.
//
// SiteHeader does real per-request async work (createClient() +
// supabase.auth.getUser() on every request) that can throw. Previously
// that failure could only be caught by global-error.tsx, because
// SiteHeader sat as a sibling of {children} in the TRUE root layout,
// above where src/app/error.tsx's own boundary applies. Now that
// SiteHeader is nested one level further down (inside this group's own
// layout), that class of failure is additionally caught by this
// group's own src/app/(public)/error.tsx, matching the not-found.tsx
// treatment applied below for the identical structural reason -- see
// that file's own comment.
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-lg focus:bg-primary focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-primary-foreground"
      >
        Skip to content
      </a>
      <SiteHeader />
      <div id="main-content" className="flex flex-1 flex-col">
        {children}
      </div>
      <SiteFooter />
    </>
  );
}
