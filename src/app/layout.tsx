import type { Metadata } from "next";
import { Libre_Franklin, Geist_Mono, Libre_Caslon_Text } from "next/font/google";
import "./globals.css";

// REDESIGN STEP 1: Libre Franklin (body, variable font, so every
// weight 400-700 comes from one file) and Libre Caslon Text (headings).
// latin-ext is required for Albanian (ë, ç).
const libreFranklin = Libre_Franklin({
  variable: "--font-libre-franklin",
  subsets: ["latin", "latin-ext"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const libreCaslonText = Libre_Caslon_Text({
  variable: "--font-libre-caslon",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "700"],
  style: ["normal", "italic"],
});

// LIBRUM 2.0 SEO-1: a title TEMPLATE, not a fixed string -- every route's
// own `metadata.title` (a plain string) automatically becomes
// "<that string> | Librum" via this template, so each page only ever
// sets its own short title, never the "| Librum" suffix itself. `default`
// is what still renders for the rare page with no metadata export of its
// own. The one deliberate exception is the homepage, which uses
// `title: { absolute: "..." }` to keep its own full brand title exactly
// as-is without the template appending a redundant second "| Librum".
export const metadata: Metadata = {
  title: {
    default: "Librum — botoni librat tuaj elektronikë",
    template: "%s | Librum",
  },
  description: "Platformë shqiptare për botimin dhe shitjen e librave elektronikë.",
  // ALBANIAN-2: the whole public site is Albanian (Renato 10-28).
  openGraph: { locale: "sq_AL" },
};

// ADMIN-1A.5 FINAL PRE-COMMIT ADMIN LAYOUT CORRECTION: SiteHeader/
// SiteFooter used to render directly here, unconditionally, for every
// route in the app -- including /admin/*. They now live one level
// down, in src/app/(public)/layout.tsx, which only every existing
// public/product route is nested under; src/app/admin/layout.tsx sits
// outside that group and never inherits them. This file stays the
// single, unmoved root layout (still the only one defining <html>/
// <body> -- there is no second root layout, so error.tsx/global-error.tsx/
// not-found.tsx all keep behaving exactly as Next.js's own single-root-
// layout model already documents, and every route in the app still
// gets a full page reload only on an actual server navigation, never
// on client-side transitions within either the public or admin tree).
// The "#main-content" skip-link target and its wrapping div moved into
// (public)/layout.tsx along with SiteHeader/SiteFooter, since the
// skip-link is specifically for jumping past a site header that only
// exists there now; src/app/admin/admin-shell.tsx's own header/content
// structure doesn't need it (no comparable long nav to skip past yet).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="sq"
      className={`${libreFranklin.variable} ${geistMono.variable} ${libreCaslonText.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
