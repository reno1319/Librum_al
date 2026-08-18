import Link from "next/link";
import { IconInstagram, IconFacebook } from "@/components/icons";

const SOCIAL_LINKS = [
  { href: "#", label: "Instagram", icon: IconInstagram },
  { href: "#", label: "Facebook", icon: IconFacebook },
];

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

const EXTERNAL_FOOTER_LINKS = {
  More: [
    { href: "https://www.lamajkalemi.al", label: "Boto me L&K" },
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
          <div
            className="mt-4"
            style={{ display: "flex", gap: "0.75rem" }}
          >
            {SOCIAL_LINKS.map((social) => (
              <a
                key={social.label}
                href={social.href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={social.label}
                className="text-muted hover:text-foreground"
              >
                <social.icon style={{ width: "1.25rem", height: "1.25rem" }} />
              </a>
            ))}
          </div>
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
          {Object.entries(EXTERNAL_FOOTER_LINKS).map(([section, links]) => (
            <div key={section}>
              <p className="text-xs font-medium uppercase tracking-wide text-muted">
                {section}
              </p>
              <nav
                className="mt-3 text-sm"
                style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
              >
                {links.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    {link.label}
                  </a>
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
