import Link from "next/link";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { BLOG_CATEGORY_LABELS_SQ } from "@/lib/blog-categories";
import type { BlogCategory } from "@/lib/types";

// LIBRUM 2.0 BLOG-1D: the shared public article card -- /blog's
// featured/latest/category sections and the article page's own related-
// reading section all render this same component. Mirrors BookCard's
// own hierarchy (cover, one label line, title, one more line) rather
// than introducing a new visual pattern -- cover-to-link,
// hover-lift-on-image, focus-ring on the link, same shadow/rounding
// tokens. Deliberately no reading-time badge here (see the /blog page's
// own comment on why cards omit it): keeping this card's own query
// surface to summary columns only (never content_markdown) is what
// keeps the landing page's one bounded query actually small.
export type BlogArticleCardPost = {
  slug: string;
  title: string;
  excerpt: string;
  category: BlogCategory;
  coverUrl: string | null;
  published_at: string | null;
};

export function BlogArticleCard({ post }: { post: BlogArticleCardPost }) {
  return (
    <Link
      href={`/blog/${post.slug}`}
      className="focus-ring group flex flex-col gap-3 rounded-sm"
    >
      {post.coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={post.coverUrl}
          alt=""
          className="aspect-[3/2] w-full rounded-md object-cover shadow-sm transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-md motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
        />
      ) : (
        <div className="aspect-[3/2] w-full rounded-md bg-border" />
      )}
      <div>
        <span className="text-xs font-medium uppercase tracking-wide text-muted">
          {BLOG_CATEGORY_LABELS_SQ[post.category]}
        </span>
        <p className="font-serif text-base font-semibold leading-snug text-foreground">
          {post.title}
        </p>
        <p className="mt-1 line-clamp-2 text-sm text-muted">{post.excerpt}</p>
        {post.published_at && (
          <p className="mt-2 text-xs text-muted">{formatTimestampAsDate(post.published_at)}</p>
        )}
      </div>
    </Link>
  );
}
