import Link from "next/link";
import { REPLY_PROMISE, SUPPORT_EMAIL } from "@/lib/contact";
import { IconInstagram } from "@/components/icons";

// SOCIAL (Renato soc3, 2026-11-18): Librum's real Instagram page, as an
// icon under the reply promise, on every page. A plain link; nothing
// from Instagram loads on Librum.
export const INSTAGRAM_HREF = "https://www.instagram.com/librum.al";
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
  Zbuloni: [
    { href: "/librari", label: "Libraria" },
    { href: "/blog", label: "Blog" },
    { href: "/rreth-nesh", label: "Rreth nesh" },
  ],
  Publikoni: [
    { href: "/si-funksionon", label: "Si funksionon" },
    { href: "/fitimet", label: "Fitimet" },
  ],
  Mbështetje: [
    { href: "/ndihme", label: "Ndihmë" },
    { href: "/kontakt", label: "Kontakt" },
  ],
  Ligjore: [
    { href: "/kushtet", label: "Kushtet e përdorimit" },
    { href: "/privatesia", label: "Privatësia" },
    { href: "/rimbursimet", label: "Rimbursimet" },
    { href: "/aksesueshmeria", label: "Aksesueshmëria" },
  ],
};

// Preserved exactly -- a real, working partner destination, not a
// placeholder. Styled below as a secondary/external link, distinct
// from Librum's own product links.
const BOTO_ME_LK_HREF = "https://www.lamajkalemi.al";

// REDESIGN STEP 2 (A2 "Library Green & Brass"): the footer is the
// darkest green on the site (primary-hover), one step below the header
// and the homepage's closing green band so the two don't merge. Text is
// cream: full strength 14.5:1, the softer 80% shade still well above AA.
// Footer navigation links underline on hover; the support email sits
// inside a sentence, so it is underlined at rest.
export function SiteFooter() {
  return (
    <footer className="bg-primary-hover text-primary-foreground">
      <div className="page-container flex flex-col gap-8 py-8 md:flex-row md:justify-between">
        <div className="max-w-xs">
          <span className="font-serif text-[1.625rem]">Librum</span>
          <p className="mt-2 text-[0.9375rem] leading-relaxed text-primary-foreground/80">
            Libra elektronikë të pavarur, të botuar drejtpërdrejt nga ata
            që i shkruajnë.
          </p>
          <p className="mt-3 text-[0.9375rem] text-primary-foreground/80">
            Pyetje?{" "}
            <a
              href={`mailto:${SUPPORT_EMAIL}`}
              className="focus-ring rounded-sm text-primary-foreground underline underline-offset-2 hover:decoration-2"
            >
              {SUPPORT_EMAIL}
            </a>
          </p>
          {/* TRUST PACK (item 5, 5. a): the reply promise under the email. */}
          <p className="mt-1 text-[0.9375rem] text-primary-foreground/80">{REPLY_PROMISE}</p>
          <a
            href={INSTAGRAM_HREF}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Librum në Instagram"
            title="Librum në Instagram"
            className="focus-ring mt-1.5 -ml-2.5 inline-flex size-11 items-center justify-center rounded-full text-primary-foreground hover:bg-primary-foreground/10"
          >
            <IconInstagram className="size-[1.375rem]" />
          </a>
        </div>

        <div className="grid grid-cols-2 gap-x-10 gap-y-6 sm:grid-cols-4">
          {Object.entries(FOOTER_GROUPS).map(([section, links]) => (
            <div key={section}>
              <p className="text-[0.9375rem] font-semibold text-primary-foreground">
                {section}
              </p>
              <nav aria-label={section} className="mt-2 flex flex-col gap-1.5 text-[0.9375rem]">
                {links.map((link) => (
                  <Link
                    key={link.href}
                    href={link.href}
                    className="focus-ring rounded-sm text-primary-foreground/80 hover:text-primary-foreground hover:underline"
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </div>
          ))}
        </div>
      </div>

      <div className="border-t border-primary-foreground/15">
        <div className="page-container flex flex-col gap-2 py-3 text-sm text-primary-foreground/80 sm:flex-row sm:items-center sm:justify-between">
          <span>&copy; {new Date().getFullYear()} Librum.</span>
          {/* Styled as a secondary partner link -- smaller, muted, an
              explicit external-link mark -- so it doesn't read as a
              primary Librum product link. */}
          <a
            href={BOTO_ME_LK_HREF}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring rounded-sm hover:text-primary-foreground hover:underline"
          >
            Boto me L&amp;K ↗
            <span className="sr-only"> (hapet në një skedë të re)</span>
          </a>
        </div>
      </div>
    </footer>
  );
}
