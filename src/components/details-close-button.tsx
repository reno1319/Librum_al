"use client";

import { IconClose } from "@/components/icons";

// LR1: the ✕ inside an open <details> box (Libraria's "Më shumë
// kategori"). It closes the box it sits in and puts focus back on the
// box's own button. Without JavaScript it does nothing; the box's
// button still closes it.
export function DetailsCloseButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-surface-hover"
      onClick={(e) => {
        const details = e.currentTarget.closest("details");
        if (!details) return;
        details.open = false;
        details.querySelector<HTMLElement>("summary")?.focus();
      }}
    >
      <IconClose className="size-5" />
    </button>
  );
}
