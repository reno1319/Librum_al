// The "Nga …" line under an article's title. A typed "Written by" name
// shows on any article. au2 reversed (Renato 2026-11-23, as Enkelejd
// expected): with no name, every article shows "Nga Librum", Editorial
// or not. Decided when the page is shown, so older posts follow too.
export function blogBylineName(post: { author_name?: string | null; is_editorial: boolean }): string {
  const name = (post.author_name ?? "").trim();
  return name || "Librum";
}

// au3 a (Renato 2026-11-22): the Article JSON-LD author. A typed name is
// a Person; with no name an Editorial article keeps "Librum Editorial"
// (blog categories audit F3) and, since au2 was reversed (2026-11-23),
// every other article names "Librum", matching its visible byline.
export function blogJsonLdAuthor(post: {
  author_name?: string | null;
  is_editorial: boolean;
}): { "@type": "Person" | "Organization"; name: string } {
  const name = (post.author_name ?? "").trim();
  if (name) return { "@type": "Person", name };
  return { "@type": "Organization", name: post.is_editorial ? "Librum Editorial" : "Librum" };
}
