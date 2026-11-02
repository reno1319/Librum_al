import { STANDARD_ROYALTY_PERCENT } from "@/lib/royalty";

// LIBRUM 2.0 UI-3: a homepage-local decision boundary, deliberately
// separate from src/components/site-header.tsx's HeaderCta -- same
// shape by coincidence (label + href), not by shared type, since the
// homepage's hero/final CTAs are a different decision (two slots, not
// one) with different destinations for the author case (Dashboard vs.
// the actual create-book flow). Mirrors buildSiteHeaderNav()'s own
// "extract a pure decision function, unit-test it directly" pattern --
// see src/lib/homepage.test.ts.
export type HomepageCta = {
  label: string;
  href: string;
};

export type HomepageCtaState = {
  hero: HomepageCta | null;
  final: HomepageCta | null;
};

export function resolveHomepageCta(params: {
  user: { id: string } | null;
  role: string | null;
}): HomepageCtaState {
  const { user, role } = params;

  if (!user) {
    const cta: HomepageCta = { label: "Publikoni librin tuaj", href: "/signup?role=author" };
    return { hero: cta, final: cta };
  }

  if (role === "author") {
    return {
      hero: { label: "Shkoni te Paneli i autorit", href: "/dashboard" },
      final: { label: "Filloni një libër të ri", href: "/dashboard/books/new" },
    };
  }

  // A reader (or any non-author authenticated role) gets no publishing
  // CTA here. BECOME-AUTHOR-1 added a reader -> author switch on
  // /account; pointing the homepage at it is a separate product choice
  // that has not been made.
  return { hero: null, final: null };
}

// AUTHOR PAGES REDESIGN (Renato's R5 a): the closing band's button on
// About, How it works, Earnings and Help. Signed out and author get the
// home page's final CTA; a signed-in reader gets the account page's
// "Become an author" section (rendered only for role "reader"). Anyone
// else signed in (an admin, a missing profile) gets no band, as on the
// home page.
export function resolveAuthorPageCta(params: {
  user: { id: string } | null;
  role: string | null;
}): HomepageCta | null {
  if (params.user && params.role === "reader") {
    return { label: "Bëhuni autor", href: "/account#become-author" };
  }
  return resolveHomepageCta(params).final;
}

// LIBRUM 2.0 UI-3: the single source authors' displayed share derives
// from, never a literal written on a page. BD2 (Renato 11-01, 4a): it is
// the standard royalty from src/lib/royalty.ts (70%, from 199 lek), shown
// with ROYALTY_HEADLINE_CAPTION ("50% below 199") wherever it is big. It
// no longer reads PLATFORM_FEE_PERCENT, which still drives the real
// checkout until the live POK build (N6).
export function computeAuthorSharePercent(): number {
  return STANDARD_ROYALTY_PERCENT;
}
