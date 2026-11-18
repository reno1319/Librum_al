import Link from "next/link";
import { BLOG_CATEGORIES, BLOG_CTA, blogCategoryHref } from "@/lib/blog-categories";
import type { BlogSection } from "@/lib/types";

// Blog categories (2026-11-17): the row of category buttons under the
// /blog intro and on every category page. "Të gjitha" goes back to
// /blog; each other button opens its category page and carries a dot
// in the category's colour (the active one is filled instead). One row
// at desktop; on a phone the row scrolls sideways.
export function BlogCategoryButtons({ active }: { active: BlogSection | null }) {
  const base =
    "focus-ring inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-3.5 py-1.5 text-sm";
  return (
    <nav aria-label="Kategoritë e blogut">
      <ul className="-mr-4 flex gap-2 overflow-x-auto pr-4 [scrollbar-width:none] sm:mr-0 sm:flex-wrap sm:overflow-visible sm:pr-0">
        <li className="shrink-0">
          <Link
            href="/blog"
            aria-current={active === null ? "page" : undefined}
            className={
              active === null
                ? `${base} border-primary bg-primary text-primary-foreground`
                : `${base} border-control bg-surface text-foreground hover:bg-surface-hover`
            }
          >
            Të gjitha
          </Link>
        </li>
        {BLOG_CATEGORIES.map((c) => {
          const on = c.value === active;
          return (
            <li key={c.value} className="shrink-0">
              <Link
                href={blogCategoryHref(c)}
                aria-current={on ? "page" : undefined}
                className={
                  on
                    ? `${base} text-white`
                    : `${base} border-control bg-surface text-foreground hover:bg-surface-hover`
                }
                style={on ? { backgroundColor: c.ink, borderColor: c.ink } : undefined}
              >
                {!on && (
                  <span
                    aria-hidden="true"
                    className="mr-[7px] inline-block size-[9px] rounded-full"
                    style={{ backgroundColor: c.ink }}
                  />
                )}
                {c.shortLabel}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// The bottom button (blog6): "publish" on /blog and in the two author
// categories, "browse" in the reader categories and Editorial.
export function BlogCta({ kind }: { kind: "publish" | "browse" }) {
  const cta = BLOG_CTA[kind];
  return (
    <div className="mt-14 border-t border-border pt-8 text-center">
      <p className="text-muted">{cta.prompt}</p>
      <Link
        href={cta.href}
        className="mt-3 inline-block rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
      >
        {cta.label}
      </Link>
    </div>
  );
}
