// Blog search box (bs6 a): at the top of /blog, every category page and
// the results page. A plain GET form to /blog/kerko, so it works with
// no JavaScript and a search can be shared or bookmarked. Same cream
// pill and green round button as the bookstore search (16px text so
// iPhone Safari does not zoom in). Searches the blog only, never books.
export function BlogSearchBox({ defaultValue = "" }: { defaultValue?: string }) {
  return (
    <form action="/blog/kerko" method="get" role="search" className="relative flex max-w-xl">
      <label htmlFor="blog-q" className="sr-only">
        Kërko në blog
      </label>
      <input
        id="blog-q"
        type="search"
        name="q"
        defaultValue={defaultValue}
        maxLength={100}
        placeholder="Kërko në blog…"
        className="focus-ring h-11 w-full min-w-0 rounded-full border border-border bg-[#f1eee6] pr-12 pl-5 text-base text-foreground"
      />
      <button
        type="submit"
        aria-label="Kërko"
        className="focus-ring group absolute top-0 right-0 flex size-11 items-center justify-center rounded-full"
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors group-hover:bg-primary-hover">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
      </button>
    </form>
  );
}
