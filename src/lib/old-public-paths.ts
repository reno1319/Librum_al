// ALBANIAN-15 (Renato 10-29, "1. a"): the English addresses the public
// catalog pages had before they moved to Albanian ones. next.config.ts
// redirects each to its new address; ":path*" also matches the bare
// address, and Next keeps the query string. Kept here, not inline, so
// old-public-paths.test.ts can check each new address is a real page.
export const OLD_PUBLIC_PATHS = [
  { source: "/bookstore", destination: "/librari", permanent: true },
  { source: "/books/:path*", destination: "/libra/:path*", permanent: true },
  { source: "/authors/:path*", destination: "/autore/:path*", permanent: true },
  { source: "/series/:path*", destination: "/seri/:path*", permanent: true },
  { source: "/bundles/:path*", destination: "/paketa/:path*", permanent: true },
] as const;
