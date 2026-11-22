// au2 a (Renato 2026-11-22): the "Nga …" line under an article's title.
// A typed "Written by" name shows on any article; with no name an
// Editorial article shows "Nga Librum" and every other article none
// (as before). Returns the name to put after "Nga", or null for no
// byline.
export function blogBylineName(post: { author_name?: string | null; is_editorial: boolean }): string | null {
  const name = (post.author_name ?? "").trim();
  if (name) return name;
  return post.is_editorial ? "Librum" : null;
}

// au3 a (Renato 2026-11-22): the Article JSON-LD author. A typed name is
// a Person; with no name an Editorial article keeps "Librum Editorial"
// and every other article names none (blog categories audit F3).
export function blogJsonLdAuthor(post: {
  author_name?: string | null;
  is_editorial: boolean;
}): { "@type": "Person" | "Organization"; name: string } | null {
  const name = (post.author_name ?? "").trim();
  if (name) return { "@type": "Person", name };
  return post.is_editorial ? { "@type": "Organization", name: "Librum Editorial" } : null;
}
