import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="border-t border-border px-4 py-8 text-sm text-muted sm:px-6">
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-4">
        <span className="font-serif text-primary">Librum</span>
        <nav className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/about" className="hover:underline">
            About
          </Link>
          <Link href="/how-it-works" className="hover:underline">
            How it works
          </Link>
          <Link href="/help" className="hover:underline">
            Help
          </Link>
          <Link href="/contact" className="hover:underline">
            Contact
          </Link>
          <Link href="/terms" className="hover:underline">
            Terms
          </Link>
          <Link href="/privacy" className="hover:underline">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
