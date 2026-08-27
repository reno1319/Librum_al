"use client";

import { useEffect, useRef, useState } from "react";
import { parseDocxToDocument, packageEpub } from "@/app/dashboard/books/docx-actions";
import type { ConversionWarning, DocSection } from "@/lib/docx-converter";
import { fileInputClasses } from "@/lib/form-styles";

// LIBRUM 2.0 PRODUCT-5: the Studio's manuscript picker -- EPUB upload
// (unchanged, still the direct/expert path) or DOCX, which Librum
// converts via two small Server Actions
// (src/app/dashboard/books/docx-actions.ts): parseDocxToDocument()
// (Mammoth, runs once per file) and packageEpub() (pure JSZip
// packaging + the real validateEpubStructure() check, cheap enough to
// re-run every time the book title changes).
//
// LIBRUM 2.0 PRODUCT-5 FINAL PRE-COMMIT CORRECTION: three correctness
// gaps closed here, all in service of one invariant -- the EPUB
// actually submitted to createBook()/updateBook() must carry the
// title the author is actually saving, never a stale one:
//
//   1. LIVE TITLE, ONE MECHANISM FOR BOTH PAGES. Rather than trust a
//      `bookTitle` prop (which only updates on a parent re-render),
//      this reads the surrounding <form>'s own "title" field directly
//      via a native `input` DOM event listener, found through
//      `hiddenInputRef.current.form`. A real keystroke fires that
//      native event regardless of whether the field is React-
//      controlled (the new-book wizard's title input) or plain
//      `defaultValue`-uncontrolled (Edit Book's, left completely
//      unmodified by this correction) -- so one mechanism covers both
//      pages with zero changes to either page's own title input.
//   2. OUT-OF-ORDER RESPONSE GUARD. Every packageEpub() call captures
//      a locally-incremented request id; a response is only ever
//      applied if no newer request has started since. A slow response
//      for an old title can never clobber a faster response for a
//      newer one.
//   3. SUBMIT-WHILE-REPACKAGING GUARD. The surrounding form's own
//      `submit` event is intercepted while any packaging is still in
//      flight -- deferred (not lost) until the latest packaging
//      settles, then resubmitted automatically. A direct EPUB upload
//      never has anything pending, so this never touches that path.
//
// Whichever path produces a File, it's written into ONE hidden
// `<input type="file" name="manuscript">` via the DataTransfer API,
// so the surrounding <form action={createBook|updateBook}> submits it
// exactly as if the author had picked an EPUB themselves --
// createBook()/updateBook() remain completely unmodified.
type Status = "idle" | "converting" | "success" | "error";

type ParsedDocument = {
  sections: DocSection[];
  images: { filename: string; mediaType: string; base64: string }[];
};

export function ManuscriptField({
  bookTitle,
  authorName,
  onManuscriptChange,
  existingFilename,
}: {
  // Initial seed only -- see the title-input listener effect below for
  // why this isn't the ongoing source of truth once mounted.
  bookTitle: string;
  // Never live-edited anywhere in either book form (no author-name
  // field exists in Book Details -- it's profiles.display_name, only
  // ever changed from Dashboard > Profile, a different page/session
  // entirely), so unlike title this genuinely has no equivalent
  // staleness/race to guard against -- a plain, stable prop is
  // correct as-is.
  authorName: string;
  onManuscriptChange: (file: File | null) => void;
  // Edit-page only: the currently-stored manuscript's own name, shown
  // so "leave blank to keep the existing file" reads correctly instead
  // of implying a manuscript is required on every edit.
  existingFilename?: string;
}) {
  const [mode, setMode] = useState<"epub" | "docx">("epub");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [warnings, setWarnings] = useState<ConversionWarning[]>([]);

  const hiddenInputRef = useRef<HTMLInputElement>(null);
  const liveTitleRef = useRef(bookTitle);
  const parsedDocumentRef = useRef<ParsedDocument | null>(null);
  const sourceFilenameRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const pendingCountRef = useRef(0);
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());

  function setHiddenFile(file: File | null) {
    if (!hiddenInputRef.current) return;
    const transfer = new DataTransfer();
    if (file) transfer.items.add(file);
    hiddenInputRef.current.files = transfer.files;
    onManuscriptChange(file);
  }

  async function packageAndSwap(doc: ParsedDocument, epubFilenameBase: string) {
    const myRequestId = ++requestIdRef.current;
    pendingCountRef.current += 1;
    setStatus("converting");

    const run = (async () => {
      try {
        const result = await packageEpub(liveTitleRef.current, authorName, doc.sections, doc.images);

        // Out-of-order guard: a newer request may have started (and
        // possibly already finished) while this one was in flight --
        // its result is discarded entirely rather than allowed to
        // overwrite whatever the newer request already applied.
        if (myRequestId !== requestIdRef.current) {
          return;
        }

        if (!result.success) {
          setStatus("error");
          setErrorMessage(result.error);
          setHiddenFile(null);
          return;
        }

        const bytes = Uint8Array.from(atob(result.epubBase64), (c) => c.charCodeAt(0));
        const epubFile = new File([bytes], `${epubFilenameBase}.epub`, { type: "application/epub+zip" });
        setStatus("success");
        setHiddenFile(epubFile);
      } finally {
        pendingCountRef.current -= 1;
      }
    })();

    inFlightRef.current = run;
    await run;
  }

  // Live title: reads the surrounding form's own "title" field
  // directly, not the bookTitle prop -- see the top-of-file comment
  // for why. Also the trigger for re-packaging on every real edit.
  useEffect(() => {
    const form = hiddenInputRef.current?.form;
    const rawTitleInput = form?.elements.namedItem("title");
    if (!(rawTitleInput instanceof HTMLInputElement)) return;
    // Explicitly typed (not just narrowed) so the nested closure below --
    // which TypeScript can't prove runs synchronously with this check --
    // still sees a real HTMLInputElement rather than reverting to the
    // pre-narrowed Element | RadioNodeList union.
    const titleInput: HTMLInputElement = rawTitleInput;

    liveTitleRef.current = titleInput.value;

    function handleTitleInput() {
      liveTitleRef.current = titleInput.value;
      if (parsedDocumentRef.current && sourceFilenameRef.current) {
        void packageAndSwap(
          parsedDocumentRef.current,
          sourceFilenameRef.current.replace(/\.docx$/i, ""),
        );
      }
    }

    titleInput.addEventListener("input", handleTitleInput);
    return () => titleInput.removeEventListener("input", handleTitleInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Submit-while-repackaging guard: while ANY packaging triggered by
  // this component is still in flight, a Save/Continue click on the
  // surrounding form is deferred (never dropped) until the latest one
  // settles, then the form is resubmitted automatically. Never
  // intercepts anything when mode is "epub" (pendingCountRef is only
  // ever incremented by packageAndSwap, which the direct-EPUB path
  // never calls).
  useEffect(() => {
    const form = hiddenInputRef.current?.form;
    if (!form) return;

    function handleSubmit(e: Event) {
      if (pendingCountRef.current === 0) return;
      // stopImmediatePropagation, not just preventDefault: this must
      // win the race against React's own submit handling for the
      // form's `action` prop, which is also attached directly to this
      // element -- capture phase (below) already runs this before any
      // bubble-phase listener, but a same-phase safety margin is kept
      // too since Next.js Server Actions can wire additional
      // native-form submit handling of their own.
      e.preventDefault();
      e.stopImmediatePropagation();
      void (async () => {
        while (pendingCountRef.current > 0) {
          await inFlightRef.current;
        }
        form!.requestSubmit();
      })();
    }

    // Capture phase: runs before any bubble-phase listener on this
    // same element (including React's own submit handling for
    // `action={fn}`), so the guard above can reliably win the race and
    // stop a premature submission before React ever begins processing
    // it.
    form.addEventListener("submit", handleSubmit, true);
    return () => form.removeEventListener("submit", handleSubmit, true);
  }, []);

  function handleEpubChange(file: File | null) {
    setStatus("idle");
    setErrorMessage("");
    setWarnings([]);
    parsedDocumentRef.current = null;
    sourceFilenameRef.current = null;
    setHiddenFile(file);
  }

  function handleDocxChange(file: File | null) {
    if (!file) {
      setStatus("idle");
      parsedDocumentRef.current = null;
      sourceFilenameRef.current = null;
      setHiddenFile(null);
      return;
    }
    setStatus("converting");
    setErrorMessage("");
    setWarnings([]);
    parsedDocumentRef.current = null;
    sourceFilenameRef.current = file.name;
    setHiddenFile(null);

    void (async () => {
      const formData = new FormData();
      formData.set("docx", file);
      const parsed = await parseDocxToDocument(formData);

      if (!parsed.success) {
        setStatus("error");
        setErrorMessage(parsed.error);
        return;
      }

      const doc: ParsedDocument = { sections: parsed.sections, images: parsed.images };
      parsedDocumentRef.current = doc;
      setWarnings(parsed.warnings);
      await packageAndSwap(doc, file.name.replace(/\.docx$/i, ""));
    })();
  }

  function switchMode(next: "epub" | "docx") {
    if (next === mode) return;
    setMode(next);
    setStatus("idle");
    setErrorMessage("");
    setWarnings([]);
    parsedDocumentRef.current = null;
    sourceFilenameRef.current = null;
    setHiddenFile(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <input ref={hiddenInputRef} type="file" name="manuscript" className="hidden" />

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-medium text-foreground">Manuscript format</legend>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === "epub"}
              onChange={() => switchMode("epub")}
              className="focus-ring"
            />
            EPUB — best if your ebook is already professionally formatted
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              checked={mode === "docx"}
              onChange={() => switchMode("docx")}
              className="focus-ring"
            />
            DOCX — Librum converts it into a reflowable EPUB
          </label>
        </div>
      </fieldset>

      {mode === "epub" ? (
        <label className="flex flex-col gap-1 text-sm">
          Manuscript file
          <input
            type="file"
            accept=".epub,application/epub+zip"
            className={fileInputClasses}
            onChange={(e) => handleEpubChange(e.target.files?.[0] ?? null)}
          />
          <span className="text-xs text-muted">
            EPUB · up to 50 MB.
            {existingFilename ? " Leave blank to keep your current manuscript." : ""}
          </span>
        </label>
      ) : (
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Manuscript file
            <input
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className={fileInputClasses}
              disabled={status === "converting"}
              onChange={(e) => handleDocxChange(e.target.files?.[0] ?? null)}
            />
            <span className="text-xs text-muted">DOCX · up to 50 MB.</span>
          </label>
          <p className="text-xs text-muted">
            Librum preserves common manuscript structure such as headings, paragraphs,
            basic formatting, lists, links, and supported images. Complex Word-specific
            layout may require review after conversion.
          </p>

          {status === "converting" && (
            <p role="status" className="text-sm text-muted">
              Converting manuscript…
            </p>
          )}

          {status === "error" && (
            <p
              role="alert"
              className="rounded-lg border-l-4 border-red-600 bg-surface px-3 py-2 text-sm text-red-800"
            >
              {errorMessage}
            </p>
          )}

          {status === "success" && (
            <div role="status" className="rounded-lg border-l-4 border-primary bg-surface px-3 py-2 text-sm">
              <p className="font-medium text-foreground">DOCX converted successfully.</p>
              <p className="mt-1 text-muted">
                Your generated EPUB passed Librum&apos;s validation. Review the ebook
                before publishing.
              </p>
              {warnings.length > 0 && (
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
                  {warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
