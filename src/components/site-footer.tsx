import Link from "next/link";

// Instagram/Facebook icon links were removed from render below (not
// deleted from src/components/icons.tsx, which stays reusable) because
// no real Librum social URLs exist anywhere in the repo yet — a
// href="#" placeholder reads as a dead/broken link rather than
// unimplemented. Re-add once real URLs are available.
//
// LIBRUM 2.0 UI-2: IA regrouped from the old single "Platform" bucket
// into DISCOVER/PUBLISH/SUPPORT/LEGAL -- the same six links as before,
// just organized by what a reader vs. a prospective author is actually
// looking for. Contact deliberately sits under SUPPORT, not LEGAL (a
// support contact isn't a legal document).

// Exported so BLOG-1D's own footer test can assert Blog's presence in
// Discover directly -- this repo has no component-rendering test
// infrastructure (see site-header.test.ts's own header comment), so
// testing footer content means testing the data it renders from.
export const FOOTER_GROUPS = {
  Discover: [
    { href: "/bookstore", label: "Bookstore" },
    { href: "/blog", label: "Blog" },
    { href: "/about", label: "About" },
  ],
  Publish: [
    { href: "/how-it-works", label: "How it works" },
    { href: "/pricing", label: "Earnings" },
  ],
  Support: [
    { href: "/help", label: "Help" },
    { href: "/contact", label: "Contact" },
  ],
  Legal: [
    { href: "/terms", label: "Terms" },
    { href: "/privacy", label: "Privacy" },
  ],
};

const SUPPORT_EMAIL = "support@librum.al";
// Preserved exactly -- a real, working partner destination, not a
// placeholder. Styled below as a secondary/external link, distinct
// from Librum's own product links.
const BOTO_ME_LK_HREF = "https://www.lamajkalemi.al";

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex w-full max-w-wide flex-col gap-10 px-4 py-12 sm:px-6 md:flex-row md:justify-between">
        <div className="max-w-xs">
          <span className="font-serif text-2xl text-primary">Librum</span>
          <p className="mt-2 text-sm text-muted">
            Independent ebooks, published directly by the people who wrote
            them.
          </p>
          <p className="mt-4 text-sm text-muted">
            Questions?{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="focus-ring rounded-sm text-foreground hover:underline"
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
        </div>

        <div className="grid grid-cols-2 gap-x-10 gap-y-8 sm:grid-cols-4">
          {Object.entries(FOOTER_GROUPS).map(([section, links]) => (
            <div key={section}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {section}
              </p>
              <nav className="mt-3 flex flex-col gap-2 text-sm">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="focus-ring rounded-sm hover:underline"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex w-full max-w-wide flex-col gap-3 px-4 py-4 text-xs text-muted sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>&copy; {new Date().getFullYear()} Librum.</span>
          {/* Styled as a secondary partner link -- smaller, muted, an
              explicit external-link mark -- so it doesn't read as a
              primary Librum product link. */}
          <a
            href={BOTO_ME_LK_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring rounded-sm hover:underline"
          >
            Boto me L&amp;K ↗
          </a>
        </div>
      </div>
    </footer>
  );
}
