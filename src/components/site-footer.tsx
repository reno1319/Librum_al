import Link from "next/link";

const FOOTER_LINKS = {
  Platform: [
    { href: "/about", label: "About" },
    { href: "/how-it-works", label: "How it works" },
    { href: "/pricing", label: "Pricing" },
    { href: "/help", label: "Help" },
    { href: "/contact", label: "Contact" },
  ],
  Legal: [
    { href: "/terms", label: "Terms" },
    { href: "/privacy", label: "Privacy" },
  ],
};

export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-surface">
      <div
        className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6"
        style={{
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "space-between",
          gap: "2.5rem",
        }}
      >
        <div style={{ maxWidth: "20rem" }}>
          <span className="font-serif text-2xl text-primary">Librum</span>
          <p className="mt-2 text-sm text-muted">
            Independent ebooks, published directly by the people who wrote
            them.
          </p>
        </div>

        <div style={{ display: "flex", gap: "4rem" }}>
          {Object.entries(FOOTER_LINKS).map(([section, links]) => (
            <div key={section}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {section}
              </p>
              <nav
                className="mt-3 text-sm"
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
              >
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="hover:underline"
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
        <div className="mx-auto w-full max-w-5xl px-4 py-4 text-xs text-muted sm:px-6">
          &copy; {new Date().getFullYear()} Librum.
        </div>
      </div>
    </footer>
  );
}
