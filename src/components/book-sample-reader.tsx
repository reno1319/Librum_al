"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { BookReader, type ReaderData, type ReaderEndAction } from "@/components/book-reader";

// PREVIEW-READER-1: "Lexoni një pjesë" opens the page-turning reader as a
// popup over the book page (Renato 9 Nov: popup, not its own page). The
// phone's Back button closes the popup instead of leaving the book page:
// opening adds one history entry, closing takes it back.
//
// mode "sample" = the readers' sample (GET /api/books/[id]/sample);
// mode "full"   = the author's whole book with device frames (the route
//                 only honours ?mode=full for the book's own author).
//
// Native <dialog> + showModal(): focus trap, Escape, focus return.

type LoadState = { status: "idle" | "loading" | "error" } | { status: "ready"; data: ReaderData };

export type SampleEndLink = { label: string; targetId?: string; href?: string };

const HISTORY_FLAG = "librumReader";

export function BookSampleReader({
  bookId,
  bookTitle,
  variant = "button",
  label = "Lexoni një pjesë",
  mode = "sample",
  coverUrl = null,
  endLink = null,
  triggerClassName,
}: {
  bookId: string;
  bookTitle: string;
  variant?: "button" | "text";
  label?: string;
  mode?: "sample" | "full";
  coverUrl?: string | null;
  // The end page's main button: scroll to an element on this page (the
  // price card) or follow a link.
  endLink?: SampleEndLink | null;
  // P1 book page (design B): the opening button's own look (the pill on
  // the cover, the outline pill in the price box), in place of `variant`.
  triggerClassName?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pushedRef = useRef(false);
  // Runs once the history entry has been taken back (after popstate), so
  // the browser's own scroll restore can't undo it.
  const afterCloseRef = useRef<(() => void) | null>(null);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [openKey, setOpenKey] = useState(0);

  const load = useCallback(() => {
    setState({ status: "loading" });
    fetch(`/api/books/${bookId}/sample${mode === "full" ? "?mode=full" : ""}`)
      .then((res) => {
        if (!res.ok) throw new Error("unavailable");
        return res.json() as Promise<ReaderData & { html?: unknown }>;
      })
      .then((data) => {
        if (typeof data.html !== "string" || !Array.isArray(data.toc)) throw new Error("bad");
        setState({ status: "ready", data });
      })
      .catch(() => setState({ status: "error" }));
  }, [bookId, mode]);

  // Back button (popstate) closes the popup.
  useEffect(() => {
    function onPop() {
      if (!pushedRef.current) return;
      pushedRef.current = false;
      dialogRef.current?.close();
      const after = afterCloseRef.current;
      afterCloseRef.current = null;
      if (after) window.setTimeout(after, 0);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  function open() {
    dialogRef.current?.showModal();
    setOpenKey((k) => k + 1);
    try {
      window.history.pushState({ ...(window.history.state ?? {}), [HISTORY_FLAG]: true }, "");
      pushedRef.current = true;
    } catch {
      pushedRef.current = false;
    }
    if (state.status !== "ready" && state.status !== "loading") load();
  }

  // Every way of closing (button, Escape, end-page action) goes through
  // here, so the history entry is always taken back.
  function close(after?: () => void) {
    dialogRef.current?.close();
    if (pushedRef.current) {
      // onPop (above) finishes the close and then runs `after`.
      afterCloseRef.current = after ?? null;
      window.history.back();
    } else {
      after?.();
    }
  }

  const endAction: ReaderEndAction = endLink
    ? {
        label: endLink.label,
        onSelect: () =>
          close(() => {
            if (endLink.href) {
              window.location.assign(endLink.href);
              return;
            }
            const target = endLink.targetId ? document.getElementById(endLink.targetId) : null;
            if (target) {
              target.scrollIntoView({ behavior: "smooth", block: "center" });
              target.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true });
            }
          }),
      }
    : null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={
          triggerClassName ??
          (variant === "button"
            ? buttonClasses("outline", "md")
            : "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2")
        }
      >
        {label}
      </button>

      <dialog
        ref={dialogRef}
        aria-label={mode === "full" ? `Pamja paraprake e ${bookTitle}` : `Pjesë nga ${bookTitle}`}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        className="hidden open:flex m-0 h-[100dvh] max-h-none w-screen max-w-none flex-col overflow-hidden bg-[#efebe3] p-0 backdrop:bg-black/50 sm:m-auto sm:h-[min(56rem,calc(100dvh-2rem))] sm:w-[min(78rem,calc(100vw-2rem))] sm:rounded-lg"
      >
        {state.status === "ready" ? (
          <BookReader
            key={openKey}
            data={state.data}
            coverUrl={coverUrl}
            onClose={() => close()}
            endAction={endAction}
            devices={mode === "full"}
          />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex justify-end p-2">
              <button type="button" onClick={() => close()} className={buttonClasses("text", "sm")}>
                Mbyll
              </button>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              {state.status === "error" ? (
                <>
                  <p className="text-sm text-muted">Për këtë libër nuk ka pjesë për lexim.</p>
                  <button type="button" onClick={load} className={buttonClasses("outline", "sm")}>
                    Provoni përsëri
                  </button>
                </>
              ) : (
                <p className="text-sm text-muted">{mode === "full" ? "Po përgatitet libri…" : "Po përgatitet pjesa…"}</p>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
