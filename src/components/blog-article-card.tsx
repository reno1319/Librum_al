import Link from "next/link";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { getBlogCategory, type BlogCategoryInfo } from "@/lib/blog-categories";

// LIBRUM 2.0 BLOG-1D: the shared public article card -- /blog's
// featured/latest/category sections, the category pages and the
// article page's own related-reading section all render this same
// component. Mirrors BookCard's own hierarchy (cover, one label line,
// title, one more line). Deliberately no reading-time badge here:
// keeping this card's own query surface to summary columns only (never
// content_markdown) is what keeps the landing page's one bounded query
// actually small.
//
// Blog categories (2026-11-17): the label line is the category name in
// the category's own colour; an Editorial post (bs1, is_editorial)
// shows the yellow "Nga Librum" tag first, then its category name. `compactOnMobile` (the /blog lists and the
// category pages) turns the card into a row with a small square
// picture and no excerpt below the sm breakpoint.
export type BlogArticleCardPost = {
  slug: string;
  title: string;
  excerpt: string;
  category: string;
  is_editorial: boolean;
  coverUrl: string | null;
  published_at: string | null;
};

export function NgaLibrumTag() {
  return (
    <span className="inline-block rounded-[3px] bg-accent px-2 py-[3px] text-[11px] font-semibold uppercase leading-normal tracking-[0.06em] text-accent-foreground">
      Nga Librum
    </span>
  );
}

export function BlogCategoryLabel({
  category,
  isEditorial,
  categories,
}: {
  category: string;
  isEditorial: boolean;
  categories: readonly BlogCategoryInfo[];
}) {
  const info = getBlogCategory(categories, category);
  const name = info ? (
    <span className="text-xs font-medium uppercase tracking-wide" style={{ color: info.ink }}>
      {info.label}
    </span>
  ) : null;
  if (!isEditorial) return name;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <NgaLibrumTag />
      {name}
    </span>
  );
}

export function BlogArticleCard({
  post,
  categories,
  compactOnMobile = false,
}: {
  post: BlogArticleCardPost;
  categories: readonly BlogCategoryInfo[];
  compactOnMobile?: boolean;
}) {
  const imageSize = compactOnMobile ? " max-sm:aspect-square max-sm:w-24 max-sm:flex-none" : "";
  return (
    <Link
      href={`/blog/${post.slug}`}
      className={`focus-ring group flex flex-col gap-3 rounded-sm${compactOnMobile ? " max-sm:flex-row max-sm:items-start" : ""}`}
    >
      {post.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.coverUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className={`aspect-[3/2] w-full rounded-card object-cover shadow-sm transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-md motion-reduce:transition-none motion-reduce:group-hover:translate-y-0${imageSize}`}
        />
      ) : (
        <div className={`aspect-[3/2] w-full rounded-card bg-border${imageSize}`} />
      )}
      <div className="min-w-0">
        <BlogCategoryLabel category={post.category} isEditorial={post.is_editorial} categories={categories} />
        <p className="font-serif text-base font-semibold leading-snug text-foreground">
          {post.title}
        </p>
        <p className={`mt-1 line-clamp-2 text-sm text-muted${compactOnMobile ? " max-sm:hidden" : ""}`}>
          {post.excerpt}
        </p>
        {post.published_at && (
          <p className={`mt-2 text-xs text-muted${compactOnMobile ? " max-sm:mt-1" : ""}`}>
            {formatTimestampAsDate(post.published_at)}
          </p>
        )}
      </div>
    </Link>
  );
}
