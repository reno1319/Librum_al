import type { Metadata } from "next";
import { Inter, Geist_Mono, Playfair_Display } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const playfairDisplay = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
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
    default: "Librum — self-publish your ebooks",
    template: "%s | Librum",
  },
  description: "A self-publishing platform for digital ebooks.",
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
      lang="en"
      className={`${inter.variable} ${geistMono.variable} ${playfairDisplay.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
