// FIX1 (X14): the one stand-in for a book with no cover image, used
// wherever a cover can be missing (book cards, shelves, the book page,
// dashboard rows, the Add a book preview). Renato's W-E pick: a plain
// green cover with the title in cream serif letters and the author
// underneath. It replaces the grey/black blocks those places drew.
//
// The caller passes the size and shape (the same classes its <img>
// uses), so the placeholder always occupies exactly the cover's box.
// Text is sized from that box (container query units), so one
// component reads at a 56px dashboard thumbnail and a 320px book page.
//
// aria-hidden: every caller already names the book next to it (or in
// the link around it), so the cover's own words would be read twice.
export function CoverPlaceholder({
  title,
  authorName,
  className = "",
}: {
  title: string;
  authorName?: string | null;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`relative overflow-hidden bg-primary text-primary-foreground ${className}`}
    >
      {/* The query container fills the box with no padding of its own:
          cqw on the container itself measures the viewport, so padding
          there outgrew small cards (box past its column, 0px text). The
          padding and gap sit one level in, where cqw means this cover. */}
      <div className="@container absolute inset-0">
        <div className="flex h-full flex-col items-center justify-center gap-[6cqw] px-[9cqw] text-center">
          {title.trim() && (
            <span className="line-clamp-5 font-serif text-[12cqw] leading-[1.15] break-words">
              {title}
            </span>
          )}
          {authorName?.trim() && (
            <span className="line-clamp-2 text-[7cqw] leading-tight text-primary-foreground/80 break-words">
              {authorName}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
