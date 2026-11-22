// Dashboard batch 2 (b2q1 a): the page-specific link in the staff bar.
// A blog article gets "Ndrysho" (opens it in the editor, blog.manage);
// a book page gets "Faqja e stafit" (opens the staff book page,
// reports.view) -- staff can't edit an author's book, so it never says
// "Ndrysho". Anything else gets no link. Pure, so it is tested directly.
export type StaffPageLink = { href: string; label: string };

// /blog/<one segment> pages that are not articles.
const BLOG_NON_ARTICLE = new Set(["kerko", "kategoria"]);

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function resolveStaffPageLink(
  pathname: string,
  perms: { canWritePosts: boolean; canViewBooks: boolean },
): StaffPageLink | null {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const value = decodeSegment(parts[1]);
  if (!value) return null;

  if (parts[0] === "blog" && perms.canWritePosts && !BLOG_NON_ARTICLE.has(value)) {
    return { href: `/admin/blog/open/${encodeURIComponent(value)}`, label: "Ndrysho" };
  }
  if (parts[0] === "libra" && perms.canViewBooks) {
    return { href: `/admin/books/${encodeURIComponent(value)}`, label: "Faqja e stafit" };
  }
  return null;
}
