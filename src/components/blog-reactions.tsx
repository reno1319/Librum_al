import Link from "next/link";
import { BLOG_REACTIONS, publicReactionCount, type BlogReaction, type BlogReactionCounts } from "@/lib/blog-reactions";
import { toggleBlogReaction } from "@/app/(public)/blog/[slug]/reaction-actions";

// BR1 (Renato, 2026-11-23): the reaction row at the end of an article,
// above the share row (br1 q5). Plain forms, so it works without
// JavaScript. Signed-out readers get links to sign in (br1 q2).

const BUTTON_CLASSES =
  "focus-ring inline-flex min-h-9 items-center gap-1.5 rounded-full border px-3 py-1 text-sm pointer-coarse:min-h-11";
const OFF_CLASSES = "border-border bg-surface text-foreground hover:bg-surface-hover";
const ON_CLASSES = "border-primary bg-primary/10 font-medium text-primary";

export function BlogReactions({
  postId,
  slug,
  counts,
  mine,
  signedIn,
  className,
}: {
  postId: string;
  slug: string;
  counts: BlogReactionCounts;
  mine: ReadonlySet<BlogReaction>;
  signedIn: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-muted">Si ju duk ky artikull?</p>
      <ul className="mt-2 flex flex-wrap gap-2">
        {BLOG_REACTIONS.map((reaction) => {
          const count = publicReactionCount(counts[reaction.key]);
          const on = mine.has(reaction.key);
          const content = (
            <>
              <span aria-hidden="true">{reaction.emoji}</span>
              <span>{reaction.label}</span>
              {count && <span className="tabular-nums text-muted">{count}</span>}
            </>
          );
          return (
            <li key={reaction.key}>
              {signedIn ? (
                <form action={toggleBlogReaction.bind(null, postId, slug, reaction.key)}>
                  <button type="submit" aria-pressed={on} className={`${BUTTON_CLASSES} ${on ? ON_CLASSES : OFF_CLASSES}`}>
                    {content}
                  </button>
                </form>
              ) : (
                <Link
                  href={`/login?next=${encodeURIComponent(`/blog/${slug}`)}`}
                  className={`${BUTTON_CLASSES} ${OFF_CLASSES}`}
                >
                  {content}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
      {!signedIn && <p className="mt-2 text-xs text-muted">Hyni në llogari për të reaguar.</p>}
    </div>
  );
}
