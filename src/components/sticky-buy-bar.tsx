"use client";

import { useEffect, useState } from "react";

// Patch A (Renato 11-13, 2a): phones only. Shows once the price box
// (#targetId) has scrolled fully above the screen; hides again when it
// comes back or when the reader scrolls up to it. Sits above the iPhone
// home bar (safe-area inset). The sample reader is a native <dialog>,
// which always draws above it.
export function StickyBuyBar({
  targetId,
  title,
  price,
  children,
}: {
  targetId: string;
  title: string;
  price: string;
  children: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = document.getElementById(targetId);
    const footer = document.querySelector("footer");
    if (!el) return;
    let boxGone = false;
    let footerIn = false;
    const update = () => setShow(boxGone && !footerIn);
    const io = new IntersectionObserver(([entry]) => {
      boxGone = !entry.isIntersecting && entry.boundingClientRect.top < 0;
      update();
    });
    // The bar steps aside once the site footer comes into view.
    const fo = new IntersectionObserver(([entry]) => {
      footerIn = entry.isIntersecting;
      update();
    });
    io.observe(el);
    if (footer) fo.observe(footer);
    return () => {
      io.disconnect();
      fo.disconnect();
    };
  }, [targetId]);
  return (
    <div
      data-sticky-buy-bar=""
      aria-hidden={!show}
      inert={!show}
      className={`fixed inset-x-0 bottom-0 z-30 border-t border-[#d9d3c3] bg-surface/95 px-4 pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] shadow-[0_-4px_14px_rgba(28,36,32,0.10)] backdrop-blur transition-transform duration-200 md:hidden ${
        show ? "translate-y-0" : "translate-y-full"
      }`}
    >
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate font-serif text-[1.0625rem] leading-tight text-foreground">{title}</p>
          <p className="text-sm font-semibold text-foreground">{price}</p>
        </div>
        <div className="shrink-0">{children}</div>
      </div>
    </div>
  );
}
