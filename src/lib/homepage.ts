import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";

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
    const cta: HomepageCta = { label: "Publish your book", href: "/signup?role=author" };
    return { hero: cta, final: cta };
  }

  if (role === "author") {
    return {
      hero: { label: "Go to Dashboard", href: "/dashboard" },
      final: { label: "Start a new book", href: "/dashboard/books/new" },
    };
  }

  // A reader (or any non-author authenticated role) gets no publishing
  // CTA at all -- there is no reader -> author role-conversion feature
  // anywhere in this app, so offering one here would promise something
  // the product can't deliver. See the UI-3 audit's own reasoning.
  return { hero: null, final: null };
}

// LIBRUM 2.0 UI-3: the single source authors' displayed share derives
// from -- PLATFORM_FEE_PERCENT (src/lib/pricing.ts), never a literal
// "80" written on the homepage itself. Both numbers stay derived, not
// duplicated, matching how /pricing already computes this.
export function computeAuthorSharePercent(): number {
  return 100 - PLATFORM_FEE_PERCENT;
}
