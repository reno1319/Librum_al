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
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [index, setIndex] = useState(0);

  function open() {
    dialogRef.current?.showModal();
    // Fetched on first open, and retried on a later open only if the
    // previous attempt failed -- a successful load is reused for the
    // rest of this page view rather than refetched every time the
    // dialog is reopened.
    if (state.status === "idle" || state.status === "error") {
      setIndex(0);
      loadSample(bookId, setState);
    }
  }

  function close() {
    dialogRef.current?.close();
  }

  const sections = state.status === "ready" ? state.data.sections : [];
  const hasMultipleSections = sections.length > 1;

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
        className="m-auto flex h-full max-h-full w-full max-w-full flex-col rounded-none border border-border bg-surface p-0 shadow-md backdrop:bg-foreground/40 sm:h-auto sm:max-h-[85vh] sm:w-full sm:max-w-2xl sm:rounded-lg"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Read sample</p>
            <p className="truncate font-serif text-lg font-semibold">{bookTitle}</p>
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

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
          {state.status === "loading" && (
            <p className="text-sm text-muted">Loading sample…</p>
          )}
          {(state.status === "error" || (state.status === "ready" && sections.length === 0)) && (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted">Sample unavailable for this book.</p>
              <button
                type="button"
                onClick={() => loadSample(bookId, setState)}
                className={buttonClasses("outline", "sm")}
              >
                Try again
              </button>
            </div>
          )}
          {state.status === "ready" && sections[index] && (
            <div
              className="max-w-prose text-foreground/90 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-4 [&_blockquote]:italic [&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:font-serif [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:font-serif [&_h3]:text-lg [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:mt-3 [&_ol]:list-decimal [&_p]:mt-3 [&_p:first-child]:mt-0 [&_ul]:mt-3 [&_ul]:list-disc"
              // Safe: sections[index].html is server-sanitized to a
              // small fixed allowed-tag vocabulary with zero attributes
              // on any tag (see epub-sample.ts) -- never raw manuscript
              // markup.
              dangerouslySetInnerHTML={{ __html: sections[index].html }}
            />
          )}
        </div>

        {hasMultipleSections && (
          <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-3">
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              disabled={index === 0}
              className={buttonClasses("outline", "sm")}
            >
              Previous
            </button>
            <span className="text-xs text-muted">
              {index + 1} / {sections.length}
            </span>
            <button
              type="button"
              onClick={() => setIndex((i) => Math.min(sections.length - 1, i + 1))}
              disabled={index === sections.length - 1}
              className={buttonClasses("outline", "sm")}
            >
              Next
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}
