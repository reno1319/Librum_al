// ALBANIAN-15 (Renato 10-29, "1. a"): the English addresses the public
// pages had before they moved to Albanian ones (part 1: the catalog;
// part 2: Help, info and policy pages, each a single page, so matched
// exactly; /help/reading comes before /help so it keeps its own page).
// next.config.ts redirects each to its new address; ":path*" also
// matches the bare address, and Next keeps the query string. Kept here, not inline, so
// old-public-paths.test.ts can check each new address is a real page.
export const OLD_PUBLIC_PATHS = [
  { source: "/bookstore", destination: "/librari", permanent: true },
  { source: "/books/:path*", destination: "/libra/:path*", permanent: true },
  { source: "/authors/:path*", destination: "/autore/:path*", permanent: true },
  { source: "/series/:path*", destination: "/seri/:path*", permanent: true },
  { source: "/bundles/:path*", destination: "/paketa/:path*", permanent: true },
  { source: "/help/reading", destination: "/ndihme/leximi", permanent: true },
  { source: "/help", destination: "/ndihme", permanent: true },
  { source: "/how-it-works", destination: "/si-funksionon", permanent: true },
  { source: "/pricing", destination: "/fitimet", permanent: true },
  { source: "/about", destination: "/rreth-nesh", permanent: true },
  { source: "/contact", destination: "/kontakt", permanent: true },
  { source: "/privacy", destination: "/privatesia", permanent: true },
  { source: "/terms", destination: "/kushtet", permanent: true },
  { source: "/refunds", destination: "/rimbursimet", permanent: true },
] as const;
