"use client";

import { useRef, useState } from "react";
import { IconClose } from "@/components/icons";
import { buttonClasses } from "@/components/ui/button";

// LIBRUM 2.0 PRODUCT-1: the reading surface for GET /api/books/[id]/sample
// -- a real excerpt of the book's own EPUB, already sanitized server-side
// (see src/lib/epub-sample.ts) to a small allowed-tag subset, so this
// component only ever renders that fixed, trusted tag vocabulary via
// dangerouslySetInnerHTML. No annotations/highlights/bookmarks/themes/
// font chooser/search/sharing/download/offline mode -- V1 is reading
// only, per the PRODUCT-1 brief.
//
// Native <dialog> + showModal()/close(), not a hand-built modal
// framework -- this project has no existing dialog primitive to reuse
// (audited first), and <dialog> already provides, for free, everything
// section 11 of the brief requires: implicit dialog role + aria-modal,
// a focus trap while open, Escape-to-close, and focus return to
// whatever triggered it on close. aria-label supplies the accessible
// name immediately (the book title is already known from the page,
// before the sample itself has even loaded).
type SampleSection = { html: string };
type SampleResponse = {
  bookId: string;
  title: string;
  author: string | null;
  sections: SampleSection[];
  approximatePercent: number;
};

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: SampleResponse };

// LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: on-demand extraction means
// this component genuinely cannot know in advance whether a published
// book's manuscript will actually yield a usable sample -- that's only
// ever discovered by the fetch itself. This is the sole place that
// reflects a sample_unavailable/network failure to the reader: plain
// text ("Sample unavailable for this book."), never the raw API
// response body or a storage/Supabase error (neither ever reaches the
// client at all -- see the route's own 404 handling, which returns only
// a generic { error: "sample_unavailable" } shape). Close stays
// available regardless of state (rendered unconditionally in the header,
// outside this switch). A failed fetch is attempted exactly once and
// then requires a new, explicit user action -- the "Try again" button
// below, or closing and reopening -- to attempt again; nothing here
// loops, polls, or retries on its own.
function loadSample(bookId: string, setState: (s: LoadState) => void) {
  setState({ status: "loading" });
  fetch(`/api/books/${bookId}/sample`)
    .then((res) => {
      if (!res.ok) throw new Error("sample unavailable");
      return res.json() as Promise<SampleResponse>;
    })
    .then((data) => setState({ status: "ready", data }))
    .catch(() => setState({ status: "error" }));
}

export function BookSampleReader({
  bookId,
  bookTitle,
  variant = "button",
}: {
  bookId: string;
  bookTitle: string;
  variant?: "button" | "text";
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [index, setIndex] = useState(0);

  // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: the required invariant
  // is that reading content NEVER opens, or advances, already scrolled
  // -- not on a fresh open, not on a reopen of a previously-loaded
  // sample, not after changing section, not after a successful retry.
  // contentRef points at the one, stable, independently-scrolling
  // container (its own inner content swaps -- loading / error / a
  // section's HTML -- but the container itself is never unmounted), so
  // resetting its scrollTop is safe and sufficient at every one of
  // those transitions; it never touches the page's own scroll position.
  function resetScroll() {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }

  // Wraps setState so every state transition (loading -> ready,
  // loading -> error) also resets scroll the moment new content is
  // about to render -- covers the "after a successful explicit retry"
  // requirement without duplicating the reset at each call site.
  function updateState(next: LoadState) {
    setState(next);
    resetScroll();
  }

  function open() {
    dialogRef.current?.showModal();
    // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: every open starts at
    // section 0 with scroll at 0 -- previously this only happened on a
    // fresh fetch (idle/error), so reopening a dialog that had already
    // loaded successfully could silently resume on whatever section/
    // scroll position the reader had left it at. There is no code path
    // here that ever initializes to the last section, a previously
    // selected section, or a middle chunk -- sections[0] is always
    // sections[0].
    setIndex(0);
    resetScroll();
    if (state.status === "idle" || state.status === "error") {
      loadSample(bookId, updateState);
    }
  }

  function close() {
    dialogRef.current?.close();
  }

  function goToSection(next: number) {
    setIndex(next);
    resetScroll();
  }

  const sections = state.status === "ready" ? state.data.sections : [];
  const hasMultipleSections = sections.length > 1;
  const author = state.status === "ready" ? state.data.author : null;

  return (
    <>
      <button
        type="button"
        onClick={open}
        className={
          variant === "button"
            ? buttonClasses("outline", "md")
            : "focus-ring rounded-sm text-sm font-medium text-primary hover:underline"
        }
      >
        Read sample
      </button>

      <dialog
        ref={dialogRef}
        aria-label={`Sample of ${bookTitle}`}
        onClick={(e) => {
          // A click directly on the ::backdrop lands on the <dialog>
          // element itself (never on its content, which is nested
          // inside) -- a plain, well-known way to close on backdrop
          // click without any extra positioning/measurement logic.
          if (e.target === dialogRef.current) close();
        }}
        // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: a real bug, found
        // during this pass's visual review, not just a styling nicety --
        // `<dialog>` is `display: none` by default via the UA stylesheet
        // ONLY until an author style overrides it, and a plain
        // unconditional `flex` utility on the element itself is exactly
        // such an override: it made this dialog render inline in the
        // page's own normal flow (as an empty-looking box, since nothing
        // renders for the initial "idle" load state) even before
        // showModal() was ever called, which is what the screenshot's
        // "wrong content position"/"unfinished" look actually was. Fixed
        // by starting from `hidden` (matching the native default) and
        // only switching to `flex` under Tailwind's `open:` variant
        // ([open] attribute selector) -- showModal() sets that attribute
        // exactly when it opens the dialog, so this now renders in the
        // DOM tree the whole time (required for the ref/fetch logic) but
        // is only ever visually present once actually open.
        className="hidden open:flex m-0 h-full max-h-full w-full max-w-full flex-col bg-surface p-0 shadow-md backdrop:bg-foreground/40 sm:m-auto sm:h-auto sm:max-h-[82vh] sm:w-[min(720px,calc(100vw-48px))] sm:rounded-lg sm:border sm:border-border"
      >
        {/* ============================================================
            Header -- READ SAMPLE / title / author / Close
            ============================================================ */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4 sm:px-8">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Read sample</p>
            <p className="mt-1 truncate font-serif text-xl font-semibold text-foreground">
              {bookTitle}
            </p>
            {author && <p className="mt-0.5 truncate text-sm text-muted">by {author}</p>}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close sample"
            className="focus-ring flex size-9 shrink-0 items-center justify-center rounded-sm text-foreground hover:bg-surface-hover"
          >
            <IconClose className="size-5" aria-hidden="true" />
          </button>
        </div>

        {/* ============================================================
            Content -- the only independently-scrolling region
            ============================================================ */}
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-8 sm:px-8">
          {state.status === "loading" && (
            <div className="mx-auto flex max-w-[65ch] flex-col gap-4">
              <p className="text-sm text-muted">Preparing sample…</p>
              <div aria-hidden="true" className="flex animate-pulse flex-col gap-3">
                <div className="h-3 w-11/12 rounded bg-border" />
                <div className="h-3 w-full rounded bg-border" />
                <div className="h-3 w-4/5 rounded bg-border" />
                <div className="h-3 w-2/3 rounded bg-border" />
              </div>
            </div>
          )}

          {(state.status === "error" || (state.status === "ready" && sections.length === 0)) && (
            <div className="flex min-h-[16rem] flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-muted">Sample unavailable for this book.</p>
              <button
                type="button"
                onClick={() => loadSample(bookId, updateState)}
                className={buttonClasses("outline", "sm")}
              >
                Try again
              </button>
            </div>
          )}

          {state.status === "ready" && sections[index] && (
            <div
              className="mx-auto max-w-[65ch] font-serif text-[1.0625rem] leading-[1.85] text-foreground/90 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_h1]:mt-6 [&_h1]:font-sans [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-foreground [&_h2]:mt-6 [&_h2]:font-sans [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-foreground [&_h3]:mt-5 [&_h3]:font-sans [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-foreground [&_li]:ml-5 [&_ol]:mt-4 [&_ol]:list-decimal [&_p]:mt-4 [&_p:first-child]:mt-0 [&_ul]:mt-4 [&_ul]:list-disc"
              // Safe: sections[index].html is server-sanitized to a
              // small fixed allowed-tag vocabulary with zero attributes
              // on any tag (see epub-sample.ts) -- never raw manuscript
              // markup.
              dangerouslySetInnerHTML={{ __html: sections[index].html }}
            />
          )}
        </div>

        {/* ============================================================
            Footer -- Previous/Next + section count, sample-length note
            ============================================================ */}
        {state.status === "ready" && sections.length > 0 && (
          <div className="flex shrink-0 flex-col gap-2 border-t border-border px-5 py-3 sm:px-8">
            {hasMultipleSections && (
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => goToSection(Math.max(0, index - 1))}
                  disabled={index === 0}
                  className={buttonClasses("outline", "sm")}
                >
                  Previous
                </button>
                <span className="text-xs text-muted">
                  {index + 1} of {sections.length}
                </span>
                <button
                  type="button"
                  onClick={() => goToSection(Math.min(sections.length - 1, index + 1))}
                  disabled={index === sections.length - 1}
                  className={buttonClasses("outline", "sm")}
                >
                  Next
                </button>
              </div>
            )}
            {/* LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: a thin, static
                note using the API's own approximatePercent -- describes
                what fraction of the WHOLE BOOK this sample covers, not
                how far the reader has scrolled through the sample
                itself. Deliberately not tied to `index`/section count in
                any way, so it can never be misread as reading progress. */}
            <p className="text-center text-xs text-muted">
              Sample · approximately {state.data.approximatePercent}% of book
            </p>
          </div>
        )}
      </dialog>
    </>
  );
}
