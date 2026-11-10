"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { GENRES } from "@/lib/genres";
import { DismissableDetails } from "@/components/dismissable-details";
import { BOOKSTORE_PATH, FREE_BOOKS_HREF, SITE_SEARCH_FORM_ID, headerGenreHref } from "@/lib/header-bookstore";

// P2 (design B): the header's search box and the cream row's Libraria
// links. Only the links are client code, and only for usePathname (the
// Libraria link's "you are here" mark, as NavLinks does for the others).
// The address's query is never read here: on Libraria the page itself
// adds its genre, sort and price to this search form (see
// src/lib/header-bookstore.ts).

// One form at every width: on phones it is a full-width second line of
// the green bar; from lg up it sits between the logo and the account.
// Field 40px high on phones, 38px from lg (design B), 16px text on
// phones so iPhone Safari does not zoom in on focus. A plain GET form:
// it works without JavaScript.
export function HeaderSearchForm() {
  return (
    <form
      id={SITE_SEARCH_FORM_ID}
      action={BOOKSTORE_PATH}
      method="get"
      role="search"
      className="order-last flex w-full min-w-0 lg:order-none lg:w-auto lg:max-w-[36rem] lg:flex-1"
    >
      <label htmlFor="site-search-q" className="sr-only">
        Kërkoni libra ose autorë
      </label>
      <input
        id="site-search-q"
        type="search"
        name="q"
        placeholder="Kërkoni libra ose autorë"
        className="focus-ring h-10 min-w-0 flex-1 rounded-l-[8px] border-0 bg-surface px-3 text-base text-foreground lg:h-[38px] lg:text-sm"
      />
      <button
        type="submit"
        className="focus-ring h-10 shrink-0 rounded-r-[8px] bg-accent px-4 text-sm font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground lg:h-[38px]"
      >
        Kërkoni
      </button>
    </form>
  );
}

const ROW_LINK = "focus-ring rounded-sm whitespace-nowrap";
const ROW_LINK_IDLE = `${ROW_LINK} text-primary hover:underline underline-offset-4`;
const ROW_LINK_ACTIVE = `${ROW_LINK} font-semibold text-primary underline decoration-accent decoration-2 underline-offset-[6px]`;

export function HeaderShopLinks() {
  return <HeaderShopLinksView pathname={usePathname()} />;
}

// Left side of the cream row: Libraria, the genre menu (all 18), and
// Libra falas. On Libraria, its link carries aria-current plus a brass
// underline and semibold weight (not colour alone). The current genre
// is named in the Libraria page's own heading.
export function HeaderShopLinksView({ pathname }: { pathname: string | null }) {
  const onBookstore = pathname === BOOKSTORE_PATH;

  return (
    <>
      <Link
        href={BOOKSTORE_PATH}
        aria-current={onBookstore ? "page" : undefined}
        className={onBookstore ? ROW_LINK_ACTIVE : ROW_LINK_IDLE}
      >
        Libraria
      </Link>

      {/* P2 r2 (audit B1): on phones the list is placed against the
          whole header (the nearest positioned box), 16px from each edge,
          so it never runs past the screen; from 640px up it hangs under
          the button. */}
      <DismissableDetails className="group sm:relative" closeOnLinkClick>
        <summary
          className={`${ROW_LINK_IDLE} flex cursor-pointer list-none items-center gap-1 select-none [&::-webkit-details-marker]:hidden`}
        >
          Zhanret
          <svg
            aria-hidden="true"
            viewBox="0 0 12 12"
            className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          >
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </summary>
        <nav
          aria-label="Zhanret"
          className="absolute inset-x-4 z-30 mt-2 rounded-[8px] border border-border bg-surface p-2 shadow-md sm:inset-x-auto sm:left-0 sm:w-[26rem]"
        >
          <ul className="grid gap-0.5 sm:grid-cols-2">
            {/* P2 r2 (audit note): the whole Libraria, first. */}
            <li>
              <Link
                href={BOOKSTORE_PATH}
                className="focus-ring block rounded-[4px] px-3 py-2 text-[0.9375rem] font-semibold text-primary transition-colors hover:bg-surface-hover"
              >
                Të gjitha zhanret
              </Link>
            </li>
            {GENRES.map((g) => (
              <li key={g}>
                <Link
                  href={headerGenreHref(g)}
                  className="focus-ring block rounded-[4px] px-3 py-2 text-[0.9375rem] font-medium text-foreground transition-colors hover:bg-surface-hover hover:text-primary"
                >
                  {g}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </DismissableDetails>

      <Link href={FREE_BOOKS_HREF} className={ROW_LINK_IDLE}>
        Libra falas
      </Link>
    </>
  );
}
