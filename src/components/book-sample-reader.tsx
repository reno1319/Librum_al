"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buttonClasses } from "@/components/ui/button";
import { BookReader, type ReaderData, type ReaderEndAction } from "@/components/book-reader";
import { OPEN_CANCEL_CONFIRM, positionStorageKey } from "@/lib/owned-reader";
import { reviewFormHref } from "@/lib/rate-prompt";

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

type LoadState = { status: "idle" | "loading" | "error" | "too_large" } | { status: "ready"; data: ReaderData };

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
  confirmFirst = false,
  ratePrompt = false,
}: {
  bookId: string;
  bookTitle: string;
  variant?: "button" | "text";
  label?: string;
  mode?: "sample" | "full" | "owned";
  // Buyer reader (11-15, 1a): mode "owned" while the 14-day cancel
  // window is open: ask once before the first open.
  confirmFirst?: boolean;
  // K8 rate prompt (Renato 11-20): mode "owned" for a reader with no
  // review of this book yet; the page decides. A star closes the reader
  // and opens the book page's review form with those stars chosen.
  ratePrompt?: boolean;
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
  const [confirmed, setConfirmed] = useState(false);
  // The server can also ask for the check (409), e.g. a page opened
  // before the purchase finished.
  const [needsConfirm, setNeedsConfirm] = useState(mode === "owned" && confirmFirst);
  const askConfirm = mode === "owned" && needsConfirm && !confirmed;

  const load = useCallback(
    (accept = false) => {
      setState({ status: "loading" });
      const url =
        mode === "owned"
          ? `/api/books/${bookId}/read${accept ? "?accept=1" : ""}`
          : `/api/books/${bookId}/sample${mode === "full" ? "?mode=full" : ""}`;
      fetch(url)
        .then((res) => {
          if (mode === "owned" && res.status === 409) {
            setNeedsConfirm(true);
            setConfirmed(false);
            setState({ status: "idle" });
            return null;
          }
          // Audit r1 B2: too big to open online (nothing was recorded).
          if (mode === "owned" && res.status === 413) {
            setState({ status: "too_large" });
            return null;
          }
          if (!res.ok) throw new Error("unavailable");
          return res.json() as Promise<ReaderData & { html?: unknown }>;
        })
        .then((data) => {
          if (data === null) return;
          if (typeof data.html !== "string" || !Array.isArray(data.toc)) throw new Error("bad");
          setState({ status: "ready", data });
        })
        .catch(() => setState({ status: "error" }));
    },
    [bookId, mode],
  );

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
    if (!askConfirm && state.status !== "ready" && state.status !== "loading") load(confirmed);
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
        aria-label={mode === "full" ? `Pamja paraprake e ${bookTitle}` : mode === "owned" ? bookTitle : `Pjesë nga ${bookTitle}`}
        onCancel={(e) => {
          e.preventDefault();
          close();
        }}
        className="hidden open:flex m-0 h-[100dvh] max-h-none w-screen max-w-none flex-col overflow-hidden bg-[#efebe3] p-0 backdrop:bg-black/50 sm:m-auto sm:h-[min(56rem,calc(100dvh-2rem))] sm:w-[min(78rem,calc(100vw-2rem))] sm:rounded-lg"
      >
        {askConfirm ? (
          <div className="flex h-full flex-col">
            <div className="flex justify-end p-2">
              <button type="button" onClick={() => close()} className={buttonClasses("text", "sm")}>
                Mbyll
              </button>
            </div>
            <div className="mx-auto flex max-w-md flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
              <p className="font-serif text-xl font-semibold">{bookTitle}</p>
              <p className="text-sm text-muted">{OPEN_CANCEL_CONFIRM}</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <button type="button" onClick={() => (setConfirmed(true), load(true))} className={buttonClasses("primary", "md")}>
                  Hapeni librin
                </button>
                <button type="button" onClick={() => close()} className={buttonClasses("outline", "md")}>
                  Jo tani
                </button>
              </div>
            </div>
          </div>
        ) : state.status === "ready" ? (
          <BookReader
            key={openKey}
            data={state.data}
            coverUrl={coverUrl}
            onClose={() => close()}
            endAction={endAction}
            devices={mode === "full"}
            positionKey={mode === "owned" ? positionStorageKey(bookId) : null}
            marksBookId={mode === "owned" ? bookId : null}
            ratePrompt={
              mode === "owned" && ratePrompt
                ? { bookId, onRate: (stars) => close(() => window.location.assign(reviewFormHref(bookId, stars))) }
                : null
            }
          />
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex justify-end p-2">
              <button type="button" onClick={() => close()} className={buttonClasses("text", "sm")}>
                Mbyll
              </button>
            </div>
            <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
              {state.status === "too_large" ? (
                <p className="text-sm text-muted">Ky libër është shumë i madh për t&apos;u lexuar këtu. Shkarkojeni EPUB-in dhe lexojeni në aplikacionin tuaj.</p>
              ) : state.status === "error" ? (
                <>
                  <p className="text-sm text-muted">{mode === "owned" ? "Libri nuk u hap dot." : "Për këtë libër nuk ka pjesë për lexim."}</p>
                  <button type="button" onClick={() => load(confirmed)} className={buttonClasses("outline", "sm")}>
                    Provoni përsëri
                  </button>
                </>
              ) : (
                <p className="text-sm text-muted">{mode === "sample" ? "Po përgatitet pjesa…" : "Po përgatitet libri…"}</p>
              )}
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}
