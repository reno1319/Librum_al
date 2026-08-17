import Link from "next/link";

const FOOTER_LINKS = {
  Platform: [
    { href: "/about", label: "About" },
    { href: "/how-it-works", label: "How it works" },
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
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-12 sm:flex-row sm:justify-between sm:px-6">
        <div className="max-w-xs">
          <span className="font-serif text-2xl text-primary">Librum</span>
          <p className="mt-2 text-sm text-muted">
            Independent ebooks, published directly by the people who wrote
            them.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-10 sm:gap-16">
          {Object.entries(FOOTER_LINKS).map(([section, links]) => (
            <div key={section}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {section}
              </p>
              <nav className="mt-3 flex flex-col gap-2 text-sm">
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
