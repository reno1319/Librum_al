"use client";

import { useCallback, useState, useSyncExternalStore, type ReactNode } from "react";
import { ShelfSlider } from "@/components/shelf-slider";
import { tabHandlers } from "@/components/category-shelf-tabs";
import { shelfPage, shelfPageText } from "@/lib/book-page-shelf";

// Amazon book page, patch 2 (items 11, 23, 24): the shelf under the
// book. The heading with "Faqja 1 nga 3" on its right, the chips
// ("Libra të ngjashëm", "Nga <autori>", one per category), then one
// sliding row. A tap on a chip swaps the row in place (like Libraria's
// category buttons); every chip is still a link, so with no JavaScript
// it opens that list. Every chip's row is rendered on the server.
export type BookPageShelfTab = {
  label: string;
  href: string;
  // Chip 24: the author's photo or initials before "Nga <autori>".
  leading?: ReactNode;
  items: { key: string; node: ReactNode }[];
};

const CHIP =
  "focus-ring inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full border-[1.5px] border-border bg-surface px-3.5 text-sm whitespace-nowrap text-foreground transition-colors hover:bg-surface-hover md:min-h-8";
const CHIP_ON = "border-primary! bg-primary! font-semibold text-primary-foreground!";

// One card of the row: about two and a half on a phone (128px), then 4,
// 5 and 7 across on a computer (design r7).
const ITEM =
  "flex w-32 shrink-0 snap-start sm:w-[calc((100%-4.5rem)/4)] md:w-[calc((100%-6rem)/5)] lg:w-[calc((100%-9rem)/7)]";

const noSubscribe = () => () => {};
const isBrowser = () => true;
const isServer = () => false;

export function BookPageShelf({
  id,
  heading,
  headingClassName,
  tabs,
}: {
  id: string;
  heading: string;
  headingClassName: string;
  tabs: BookPageShelfTab[];
}) {
  const [selected, setSelected] = useState(0);
  const enhanced = useSyncExternalStore(noSubscribe, isBrowser, isServer);
  const [announcement, setAnnouncement] = useState("");
  const [pageInfo, setPageInfo] = useState<{ page: number; total: number } | null>(null);
  const onPageChange = useCallback((left: number, visible: number, total: number) => {
    const next = shelfPage(left, visible, total);
    setPageInfo((current) => (current && current.page === next.page && current.total === next.total ? current : next));
  }, []);

  const current = tabs[selected] ?? tabs[0];
  if (!current) return null;

  const choose = (index: number) => {
    setSelected(index);
    setPageInfo(null);
    const tab = tabs[index];
    if (tab) setAnnouncement(`Po shfaqen: ${tab.label}.`);
  };

  return (
    <section id={id} aria-labelledby={`${id}-titulli`} className="scroll-mt-20">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 id={`${id}-titulli`} className={headingClassName}>
          {heading}
        </h2>
        {pageInfo && pageInfo.total > 1 && (
          <span data-shelf-page="" className="text-sm text-muted">
            {shelfPageText(pageInfo)}
          </span>
        )}
      </div>
      {tabs.length > 1 && (
        <div className="-mr-4 mt-3.5 flex items-center gap-2 overflow-x-auto pr-4 pb-1 [scrollbar-width:none] sm:mr-0 sm:flex-wrap sm:overflow-visible sm:pr-0 [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab, i) => {
            const on = i === selected;
            return (
              <a
                key={`${i}-${tab.href}`}
                href={tab.href}
                data-shelf-chip=""
                {...(enhanced
                  ? { role: "button", "aria-pressed": on, ...tabHandlers(i, choose) }
                  : { "aria-current": on ? ("true" as const) : undefined })}
                className={`${CHIP} ${tab.leading ? "pl-[0.3125rem]" : ""} ${on ? CHIP_ON : ""}`}
              >
                {tab.leading}
                {tab.label}
              </a>
            );
          })}
        </div>
      )}
      {enhanced && (
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      )}
      {/* A new key per chip remounts the row, so it starts again from
          its first book. */}
      <div key={selected} className="mt-1">
        <ShelfSlider label={`${heading}: ${current.label}`} onPageChange={onPageChange}>
          {current.items.map((item) => (
            <li key={item.key} className={ITEM}>
              {item.node}
            </li>
          ))}
        </ShelfSlider>
      </div>
    </section>
  );
}
