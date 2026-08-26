import type { Metadata } from "next";
import { Inter, Geist_Mono, Playfair_Display } from "next/font/google";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${geistMono.variable} ${playfairDisplay.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
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
      </body>
    </html>
  );
}
