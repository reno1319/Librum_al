"use client";

import { useState, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";

// The "Më të rinjtë" category buttons (Renato 11-26, sl-2 b, Kobo-style):
// a tap swaps the books in the row below, in place, with no reload and
// no change to the address (sl-4 a). Every button's row is rendered on
// the server up front, so the swap is instant. Each button is still a
// link to its category's results, so with no JavaScript, or a
// ctrl/middle click, it opens that page as before. The row starts again
// from its first book on each swap.
//
// Once JavaScript runs (audit CT-r1 A1), each link also acts as a
// toggle button for screen readers and keyboards: role="button" with
// aria-pressed, Space works like Enter, and a polite, hidden live line
// says which books the row now shows. Nothing changes on screen.
export type CategoryTab = { label: string; href: string; row: ReactNode };

const PILL =
  "focus-ring inline-flex min-h-11 items-center rounded-full bg-[#ecebe8] px-5 text-[0.9375rem] whitespace-nowrap text-foreground transition-colors hover:bg-[#e0ded8]";
const SELECTED = "bg-primary! text-primary-foreground!";

type ClickLike = Pick<MouseEvent, "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

// A plain left click swaps the row; a modified or middle click (or one
// already handled) is left to the browser, which opens the link.
export function swapsInPlace(event: ClickLike) {
  return !event.defaultPrevented && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

// What the hidden live line says after a swap.
export function swapAnnouncement(tab: CategoryTab, index: number) {
  return index === 0 ? "Po shfaqen librat e rinj nga të gjitha kategoritë." : `Po shfaqen librat e rinj në kategorinë ${tab.label}.`;
}

// The click and key handlers of one button, kept outside the component
// so tests can drive them without a browser.
export function tabHandlers(index: number, choose: (index: number) => void) {
  return {
    onClick: (event: ClickLike & Pick<MouseEvent, "preventDefault">) => {
      if (!swapsInPlace(event)) return;
      event.preventDefault();
      choose(index);
    },
    // Enter already clicks a link; Space does for a button, so the
    // link-as-button gets it too (and the page does not scroll).
    onKeyDown: (event: Pick<KeyboardEvent, "key" | "preventDefault">) => {
      if (event.key !== " ") return;
      event.preventDefault();
      choose(index);
    },
  };
}

// The buttons, then the shown row. `enhanced` is false on the server
// and before JavaScript runs: plain links.
export function CategoryShelfTabsView({
  tabs,
  more,
  selected,
  enhanced,
  announcement,
  choose,
}: {
  tabs: CategoryTab[];
  more?: ReactNode;
  selected: number;
  enhanced: boolean;
  announcement: string;
  choose: (index: number) => void;
}) {
  const current = tabs[selected] ?? tabs[0];
  return (
    <>
      <div className="-mx-4 mt-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:relative sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
        {tabs.map((tab, i) => {
          const on = i === selected;
          return (
            <a
              key={tab.href}
              href={tab.href}
              {...(enhanced
                ? { role: "button", "aria-pressed": on, ...tabHandlers(i, choose) }
                : { "aria-current": on ? ("true" as const) : undefined })}
              className={on ? `${PILL} ${SELECTED}` : PILL}
            >
              {tab.label}
            </a>
          );
        })}
        {more}
      </div>
      {enhanced && (
        <p className="sr-only" aria-live="polite">
          {announcement}
        </p>
      )}
      {/* A new key per category remounts the row, so it starts again
          from its first book. */}
      <div key={current?.href}>{current?.row}</div>
    </>
  );
}

const noSubscribe = () => () => {};
const isBrowser = () => true;
const isServer = () => false;

export function CategoryShelfTabs({ tabs, more }: { tabs: CategoryTab[]; more?: ReactNode }) {
  const [selected, setSelected] = useState(0);
  // False on the server and while hydrating, true once JavaScript runs.
  const enhanced = useSyncExternalStore(noSubscribe, isBrowser, isServer);
  const [announcement, setAnnouncement] = useState("");

  const choose = (index: number) => {
    setSelected(index);
    const tab = tabs[index];
    if (tab) setAnnouncement(swapAnnouncement(tab, index));
  };

  return (
    <CategoryShelfTabsView
      tabs={tabs}
      more={more}
      selected={selected}
      enhanced={enhanced}
      announcement={announcement}
      choose={choose}
    />
  );
}
