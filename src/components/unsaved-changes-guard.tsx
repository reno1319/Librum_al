"use client";

import { useEffect, useRef } from "react";

// Upload notes 1 (Enkelejd 11-06): a link on an editor tab dropped the
// author's unsaved typing without a word. Rendered inside one of the
// editor's forms, this marks the form as changed on the first input,
// and while it is changed:
//   * closing or reloading the tab asks the browser's own "Leave site?";
//   * a click on a link that leaves the page in this tab (the editor's
//     tabs, "Librat e mi", the site menu) first asks UNSAVED_LEAVE_QUESTION.
// A link that opens a new tab, an in-page "#" link and a modified click
// (Cmd/Ctrl/Shift, middle button) are not asked about: the page stays.
// Sending the form (any of its buttons) clears the mark; a form that
// refuses its own send in the browser marks itself again
// (keepUnsavedMark). A field with data-unsaved-ignore (the Pricing
// tab's two ticks, which are asked again on every send and never kept
// by "Ruaj draftin") does not count as a change.
// Not covered: the browser's own Back button inside the site.

export const UNSAVED_LEAVE_QUESTION =
  "Keni ndryshime që nuk janë ruajtur. Nëse dilni nga kjo faqe, ato humbasin. Të dilni gjithsesi?";

/**
 * Whether a click on this link would leave the current page in this tab.
 * Exported for tests.
 */
export function clickLeavesPage(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented">,
  anchor: Pick<HTMLAnchorElement, "href" | "target" | "hasAttribute">,
  current: { href: string },
): boolean {
  if (event.defaultPrevented || event.button !== 0) return false;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (!anchor.href || anchor.hasAttribute("download")) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  let to: URL;
  let from: URL;
  try {
    to = new URL(anchor.href);
    from = new URL(current.href);
  } catch {
    return false;
  }
  // Only the "#..." part changes: the same page, scrolled.
  if (to.origin === from.origin && to.pathname === from.pathname && to.search === from.search) return false;
  return true;
}

export function UnsavedChangesGuard() {
  const markerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const form = markerRef.current?.closest("form");
    if (!form) return;
    let changed = false;
    const markChanged = (event: Event) => {
      if ((event.target as Element | null)?.closest?.("[data-unsaved-ignore]")) return;
      changed = true;
    };
    const clearChanged = () => {
      changed = false;
    };
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!changed) return;
      event.preventDefault();
      // Older browsers need returnValue set to show their prompt.
      event.returnValue = "";
    };
    // Capture phase on window: runs before Next's <Link> handler, so a
    // "stay" answer stops the in-app navigation too.
    const onClick = (event: MouseEvent) => {
      if (!changed) return;
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!anchor || !clickLeavesPage(event, anchor, window.location)) return;
      if (window.confirm(UNSAVED_LEAVE_QUESTION)) {
        changed = false;
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };
    form.addEventListener("input", markChanged);
    form.addEventListener("change", markChanged);
    form.addEventListener("submit", clearChanged);
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("click", onClick, true);
    return () => {
      form.removeEventListener("input", markChanged);
      form.removeEventListener("change", markChanged);
      form.removeEventListener("submit", clearChanged);
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("click", onClick, true);
    };
  }, []);

  return <span ref={markerRef} hidden />;
}

/**
 * For a form whose own onSubmit refuses the send (the browser checks):
 * the typing is still unsaved, so mark it changed again. The event does
 * not bubble, so nothing else hears it.
 */
export function keepUnsavedMark(form: HTMLFormElement): void {
  form.dispatchEvent(new Event("input"));
}
