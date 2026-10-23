"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// LEFTOVERS (L1): a floating <details> menu that also closes on a tap
// outside it and on Escape, not only when its own summary is tapped
// again. Used by the phone dashboard "Section" menu and the Bookstore
// genre and price dropdowns. Without JavaScript it is a plain native
// <details>, exactly as before; the listeners exist only while it is
// open.

/** The parts of a document attachDismiss uses (a fake in tests). */
export type DismissDocument = Pick<Document, "addEventListener" | "removeEventListener" | "activeElement" | "body">;

/** The parts of a <details> element attachDismiss uses. */
export type DismissDetails = Pick<HTMLDetailsElement, "open" | "contains" | "querySelector">;

/**
 * While `details` is open: a pointerdown outside it closes it, and
 * Escape closes it. Escape moves focus to its <summary> only when focus
 * was inside the <details> or on <body>, so Escape pressed in some other
 * field never pulls focus away. With `closeOnFocusOut` (PHONE PASS r2,
 * audit N3: the Dashboard book row's ··· menu), focus moving to anything
 * outside it -- Tab past the last item -- closes it too. Returns the
 * cleanup that removes the listeners.
 */
export function attachDismiss(
  details: DismissDetails,
  doc: DismissDocument,
  { closeOnFocusOut = false }: { closeOnFocusOut?: boolean } = {},
): () => void {
  function onPointerDown(event: Event) {
    if (!details.contains(event.target as Node | null)) details.open = false;
  }
  function onFocusIn(event: Event) {
    if (!details.contains(event.target as Node | null)) details.open = false;
  }
  function onKeyDown(event: Event) {
    if ((event as KeyboardEvent).key !== "Escape" || !details.open) return;
    const active = doc.activeElement;
    const focusWasInside = !active || active === doc.body || details.contains(active);
    details.open = false;
    if (focusWasInside) details.querySelector<HTMLElement>("summary")?.focus();
  }
  doc.addEventListener("pointerdown", onPointerDown);
  doc.addEventListener("keydown", onKeyDown);
  if (closeOnFocusOut) doc.addEventListener("focusin", onFocusIn);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown);
    doc.removeEventListener("keydown", onKeyDown);
    if (closeOnFocusOut) doc.removeEventListener("focusin", onFocusIn);
  };
}

export function DismissableDetails({
  className,
  closeOnFocusOut = false,
  children,
}: {
  className?: string;
  closeOnFocusOut?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || !ref.current) return;
    return attachDismiss(ref.current, document, { closeOnFocusOut });
  }, [open, closeOnFocusOut]);

  return (
    <details ref={ref} className={className} onToggle={(e) => setOpen(e.currentTarget.open)}>
      {children}
    </details>
  );
}
