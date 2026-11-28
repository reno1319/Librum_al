"use client";

import { useEffect, useState } from "react";

// Amazon book page, patch 2 (item 13, design r7): the section bar under
// the top of the page -- "↑ Lart", then a link to each part of the page,
// and the small cover with the title on the right (no price, no button).
// It sits under the top of the page and stays at the top of the screen
// once the reader scrolls past it. Computer and tablet only; phones keep
// the bottom buy bar. Plain links: it works with no JavaScript (the
// underline of the part in view needs it).
export type SectionBarLink = { id: string; label: string };

export function activeSection(
  tops: readonly { id: string; top: number }[],
  offset: number,
): string | null {
  let active: string | null = null;
  for (const { id, top } of tops) {
    if (top - offset <= 1) active = id;
  }
  return active;
}

const LINK =
  "focus-ring inline-flex h-full items-center rounded-sm whitespace-nowrap text-foreground hover:text-primary hover:underline";
const LINK_ON = "font-semibold text-primary shadow-[inset_0_-2px_0_var(--color-primary)] hover:no-underline";

export function BookPageSectionBar({
  links,
  title,
  coverUrl,
}: {
  links: SectionBarLink[];
  title: string;
  coverUrl: string | null;
}) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const update = () => {
      const bar = document.querySelector<HTMLElement>("[data-section-bar]");
      const offset = (bar?.offsetHeight ?? 0) + 8;
      const tops = links
        .map((link) => {
          const el = document.getElementById(link.id);
          return el ? { id: link.id, top: el.getBoundingClientRect().top } : null;
        })
        .filter((v): v is { id: string; top: number } => v !== null);
      setActive(activeSection(tops, offset));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [links]);

  return (
    <nav
      aria-label="Pjesët e faqes"
      data-section-bar=""
      // The white band and its two lines reach the screen's edges
      // without widening the page (border-image outset is paint only).
      className="sticky top-0 z-20 mt-9 h-14 text-sm [border-image:linear-gradient(var(--color-border)_0_1px,var(--color-surface)_1px_calc(100%-1px),var(--color-border)_calc(100%-1px))_fill_0//0_100vmax] max-md:hidden"
    >
      <div className="flex h-full items-center gap-[1.625rem]">
        <a href="#" className={`${LINK} ${active === null ? LINK_ON : ""}`}>
          ↑ Lart
        </a>
        {links.map((link) => (
          <a
            key={link.id}
            href={`#${link.id}`}
            aria-current={active === link.id ? "location" : undefined}
            className={`${LINK} ${active === link.id ? LINK_ON : ""}`}
          >
            {link.label}
          </a>
        ))}
        <div aria-hidden="true" className="ml-auto flex min-w-0 items-center gap-2.5 max-lg:hidden">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="aspect-[5/8] w-[1.875rem] rounded-[2px] object-contain object-bottom shadow-[0_1px_3px_rgba(0,0,0,0.25)]" />
          ) : (
            <span className="aspect-[5/8] w-[1.875rem] rounded-[2px] bg-primary shadow-[0_1px_3px_rgba(0,0,0,0.25)]" />
          )}
          <span className="truncate text-base text-foreground">{title}</span>
        </div>
      </div>
    </nav>
  );
}
