"use client";

import { useEffect, useRef, useState } from "react";
import { parseDocxToDocument, repackageWithTitle } from "@/app/(public)/dashboard/books/docx-actions";
import { createClient } from "@/lib/supabase/client";
import type { ConversionWarning } from "@/lib/docx-converter";
import { fileInputClasses } from "@/lib/form-styles";

// LIBRUM 2.0 PRODUCT-5 CB-1 CORRECTION: the 413 correction moved the
// DOCX upload and the generated-EPUB response off Vercel Function
// bodies, but still finished by downloading the generated temp EPUB
// back into a browser File and submitting THAT through
// createBook()/updateBook()'s own FormData -- for a genuinely large
// generated (or directly-uploaded) EPUB, that final leg is subject to
// the exact same ~4.5MB Vercel ceiling all over again.
//
// This field now maintains one authoritative small reference instead
// -- a temporary EPUB's own Supabase Storage path -- for BOTH paths:
//
//   DOCX: unchanged upload+parseDocxToDocument()+repackageWithTitle()
//   pipeline (see docx-actions.ts), except the final "download the
//   patched EPUB back into a File" step is GONE -- repackageWithTitle()
//   already leaves the correctly-titled EPUB sitting in Storage, and
//   that's exactly where createBook()/updateBook() need it to be
//   anyway (see actions.ts's resolveManuscriptInput()).
//
//   Direct EPUB: now ALSO uploads straight to the same private
//   "manuscripts" bucket's own "<uid>/tmp/epub/<uuid>.epub" namespace,
//   instead of just being held as a File waiting to ride along in
//   FormData -- so a 5MB or 10MB directly-uploaded EPUB never touches
//   a Server Action body either.
//
// The surrounding <form> now carries a single small hidden TEXT field,
// "manuscriptStoragePath", instead of a hidden File input --
// createBook()/updateBook() download and re-validate those bytes
// themselves (defense in depth, same validateEpubStructure() every
// upload has always gone through) before writing them to the book's
// permanent manuscript path and deleting the temporary object.
//
// The live-title mechanism, out-of-order request guard, and submit-
// while-packaging guard are unchanged in spirit -- "submission ready"
// now means "the temp Storage reference is ready and settled" rather
// than "a hidden File exists," and the submit guard now also covers
// the direct-EPUB upload's own async gap (it didn't have one before).
type Status = "idle" | "converting" | "success" | "error";

const MAX_MANUSCRIPT_BYTES = 50 * 1024 * 1024;
const MANUSCRIPTS_BUCKET = "manuscripts";
const GENERIC_ERROR = "We couldn't process this manuscript. Please try again.";
const TOO_LARGE_ERROR = "This manuscript is larger than the 50 MB limit.";
const UPLOAD_FAILED_ERROR =
  "We couldn't upload your manuscript. Please check your connection and try again.";

export function ManuscriptField({
  bookTitle,
  authorName,
  authorId,
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
  // The signed-in author's own id -- used only to namespace this
  // upload's temporary Storage path ("<authorId>/tmp/..."), the same
  // "<owner_id>/<filename>" convention every existing cover/manuscript
  // path in this app already uses. Never sent anywhere else.
  authorId: string;
  // Reports only display metadata now -- never a File (see the
  // top-of-file comment for why). null whenever nothing is ready to
  // submit yet. Optional (matching CoverField's own onCoverChange) --
  // Edit Book has no use for it and, being a Server Component, cannot
  // pass an inline function here at all: an "on"-prefixed prop is
  // detected by React as an event handler and a raw function value
  // crossing the Server->Client boundary crashes the whole page
  // (empirically confirmed -- "Event handlers cannot be passed to
  // Client Component props"). Omitting the prop entirely is the fix,
  // not passing a no-op closure.
  onManuscriptChange?: (info: { name: string } | null) => void;
  // Edit-page only: the currently-stored manuscript's own name, shown
  // so "leave blank to keep the existing file" reads correctly instead
  // of implying a manuscript is required on every edit.
  existingFilename?: string;
}) {
  const [mode, setMode] = useState<"epub" | "docx">("epub");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [warnings, setWarnings] = useState<ConversionWarning[]>([]);

  const hiddenPathInputRef = useRef<HTMLInputElement>(null);
  const liveTitleRef = useRef(bookTitle);
  const modeRef = useRef<"epub" | "docx">("epub");
  // The authoritative small reference this field maintains: whichever
  // temp EPUB Storage path (direct upload OR DOCX-generated, kept
  // repackaged in place) is currently ready to submit.
  const tempPathRef = useRef<string | null>(null);
  const displayNameRef = useRef<string | null>(null);
  const requestIdRef = useRef(0);
  const pendingCountRef = useRef(0);
  const inFlightRef = useRef<Promise<void>>(Promise.resolve());
  const supabaseClientRef = useRef<ReturnType<typeof createClient> | null>(null);

  function supabase() {
    if (!supabaseClientRef.current) {
      supabaseClientRef.current = createClient();
    }
    return supabaseClientRef.current;
  }

  function setHiddenPath(path: string | null, displayName: string | null) {
    if (hiddenPathInputRef.current) {
      hiddenPathInputRef.current.value = path ?? "";
    }
    tempPathRef.current = path;
    displayNameRef.current = path ? displayName : null;
    onManuscriptChange?.(path && displayName ? { name: displayName } : null);
  }

  // Best-effort only -- see the correction's own report for what this
  // can't guarantee (an abrupt tab close never runs this). Never
  // awaited by anything the author is waiting on.
  async function removeTempObject(path: string) {
    try {
      const { error } = await supabase().storage.from(MANUSCRIPTS_BUCKET).remove([path]);
      if (error) console.error("ManuscriptField: failed to remove temporary object:", error);
    } catch (err) {
      console.error("ManuscriptField: failed to remove temporary object:", err);
    }
  }

  function beginRequest(): number {
    const id = ++requestIdRef.current;
    pendingCountRef.current += 1;
    return id;
  }
  function isStale(id: number): boolean {
    return id !== requestIdRef.current;
  }

  // Repackages the already-uploaded temp EPUB with the live title, in
  // place -- the temp path itself never changes, so "submission ready"
  // simply means this has settled, never that any bytes were
  // downloaded back into the browser.
  async function repackageAndFinalize(conversionId: string, displayName: string) {
    const myRequestId = beginRequest();
    setStatus("converting");

    const run = (async () => {
      try {
        const result = await repackageWithTitle(conversionId, liveTitleRef.current, authorName);
        if (isStale(myRequestId)) return;

        if (!result.success) {
          setStatus("error");
          setErrorMessage(result.error);
          setHiddenPath(null, null);
          return;
        }

        setStatus("success");
        setHiddenPath(conversionId, displayName);
      } catch (err) {
        console.error("ManuscriptField: repackaging failed:", err);
        if (isStale(myRequestId)) return;
        setStatus("error");
        setErrorMessage(GENERIC_ERROR);
        setHiddenPath(null, null);
      } finally {
        pendingCountRef.current -= 1;
      }
    })();

    inFlightRef.current = run;
    await run;
  }

  // Live title: reads the surrounding form's own "title" field
  // directly -- works identically for the wizard's React-controlled
  // title input and Edit Book's plain defaultValue-uncontrolled one.
  // Only a DOCX-generated manuscript needs repackaging on a title
  // change -- a directly-uploaded EPUB's own internal metadata is
  // whatever the author's own EPUB-authoring tool already wrote;
  // Librum has never rewritten a directly-uploaded EPUB's metadata.
  useEffect(() => {
    const form = hiddenPathInputRef.current?.form;
    const rawTitleInput = form?.elements.namedItem("title");
    if (!(rawTitleInput instanceof HTMLInputElement)) return;
    // Explicitly typed (not just narrowed) so the nested closure below
    // -- which TypeScript can't prove runs synchronously with this
    // check -- still sees a real HTMLInputElement rather than
    // reverting to the pre-narrowed Element | RadioNodeList union.
    const titleInput: HTMLInputElement = rawTitleInput;

    liveTitleRef.current = titleInput.value;

    function handleTitleInput() {
      liveTitleRef.current = titleInput.value;
      if (modeRef.current === "docx" && tempPathRef.current && displayNameRef.current) {
        void repackageAndFinalize(tempPathRef.current, displayNameRef.current);
      }
    }

    titleInput.addEventListener("input", handleTitleInput);
    return () => titleInput.removeEventListener("input", handleTitleInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Submit-while-uploading/packaging guard: while ANY upload/
  // conversion/repackaging triggered by this component is still in
  // flight -- for EITHER mode now, since direct EPUB also uploads
  // asynchronously -- a Save/Continue click on the surrounding form is
  // deferred (never dropped) until the latest one settles, then the
  // form is resubmitted automatically.
  useEffect(() => {
    const form = hiddenPathInputRef.current?.form;
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

  // Best-effort cleanup of an abandoned temporary object if the author
  // navigates away (a client-side route change) without saving. Does
  // NOT run on a hard reload/tab close.
  useEffect(() => {
    return () => {
      if (tempPathRef.current) void removeTempObject(tempPathRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEpubChange(file: File | null) {
    if (tempPathRef.current) {
      void removeTempObject(tempPathRef.current);
    }
    setErrorMessage("");
    setWarnings([]);
    setHiddenPath(null, null);

    if (!file) {
      setStatus("idle");
      return;
    }

    // Section 14 of the CB-1 correction: never trust client-side
    // File.size alone as the real bound (actions.ts re-checks the
    // downloaded temp bytes too), but a controlled, immediate,
    // no-network rejection here is still the right UX for an obvious
    // oversize file.
    if (file.size > MAX_MANUSCRIPT_BYTES) {
      setStatus("error");
      setErrorMessage(TOO_LARGE_ERROR);
      return;
    }

    setStatus("converting");
    const myRequestId = beginRequest();
    const tempEpubPath = `${authorId}/tmp/epub/${crypto.randomUUID()}.epub`;
    const displayName = file.name;

    const run = (async () => {
      try {
        const { error: uploadError } = await supabase()
          .storage.from(MANUSCRIPTS_BUCKET)
          .upload(tempEpubPath, file, { contentType: "application/epub+zip" });

        if (isStale(myRequestId)) return;
        if (uploadError) {
          console.error("ManuscriptField: EPUB upload failed:", uploadError);
          setStatus("error");
          setErrorMessage(UPLOAD_FAILED_ERROR);
          return;
        }

        setStatus("success");
        setHiddenPath(tempEpubPath, displayName);
      } catch (err) {
        console.error("ManuscriptField: EPUB upload failed:", err);
        void removeTempObject(tempEpubPath);
        if (isStale(myRequestId)) return;
        setStatus("error");
        setErrorMessage(GENERIC_ERROR);
      } finally {
        pendingCountRef.current -= 1;
      }
    })();

    inFlightRef.current = run;
  }

  function handleDocxChange(file: File | null) {
    if (tempPathRef.current) {
      void removeTempObject(tempPathRef.current);
    }
    setHiddenPath(null, null);

    if (!file) {
      setStatus("idle");
      return;
    }

    // Section 11 of the 413 correction, preserved here: a controlled
    // client-side rejection before any upload is attempted.
    if (file.size > MAX_MANUSCRIPT_BYTES) {
      setStatus("error");
      setErrorMessage(TOO_LARGE_ERROR);
      setWarnings([]);
      return;
    }

    setStatus("converting");
    setErrorMessage("");
    setWarnings([]);

    const myRequestId = beginRequest();
    const tempDocxPath = `${authorId}/tmp/docx/${crypto.randomUUID()}.docx`;
    const displayName = file.name.replace(/\.docx$/i, "");

    const run = (async () => {
      try {
        const { error: uploadError } = await supabase()
          .storage.from(MANUSCRIPTS_BUCKET)
          .upload(tempDocxPath, file, {
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });

        if (isStale(myRequestId)) return;
        if (uploadError) {
          console.error("ManuscriptField: DOCX upload failed:", uploadError);
          setStatus("error");
          setErrorMessage(UPLOAD_FAILED_ERROR);
          return;
        }

        const parsed = await parseDocxToDocument(tempDocxPath);
        if (isStale(myRequestId)) return;

        if (!parsed.success) {
          setStatus("error");
          setErrorMessage(parsed.error);
          return;
        }

        setWarnings(parsed.warnings);
        // repackageAndFinalize runs its own request/pending-count
        // cycle; this outer one has nothing left to guard past this
        // point.
        await repackageAndFinalize(parsed.conversionId, displayName);
      } catch (err) {
        // Never leaves the UI on "Converting manuscript…" forever, and
        // never surfaces a raw 413/network/Server-Action/StorageApiError
        // -- section 19 of the CB-1 correction brief.
        console.error("ManuscriptField: DOCX conversion failed:", err);
        void removeTempObject(tempDocxPath);
        if (isStale(myRequestId)) return;
        setStatus("error");
        setErrorMessage(GENERIC_ERROR);
      } finally {
        pendingCountRef.current -= 1;
      }
    })();

    inFlightRef.current = run;
  }

  function switchMode(next: "epub" | "docx") {
    if (next === mode) return;
    modeRef.current = next;
    setMode(next);
    setStatus("idle");
    setErrorMessage("");
    setWarnings([]);
    if (tempPathRef.current) void removeTempObject(tempPathRef.current);
    setHiddenPath(null, null);
  }

  return (
    <div className="flex flex-col gap-3">
      <input ref={hiddenPathInputRef} type="hidden" name="manuscriptStoragePath" />

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
        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1 text-sm">
            Manuscript file
            <input
              type="file"
              accept=".epub,application/epub+zip"
              className={fileInputClasses}
              disabled={status === "converting"}
              onChange={(e) => handleEpubChange(e.target.files?.[0] ?? null)}
            />
            <span className="text-xs text-muted">
              EPUB · up to 50 MB.
              {existingFilename ? " Leave blank to keep your current manuscript." : ""}
            </span>
          </label>

          {status === "converting" && (
            <p role="status" className="text-sm text-muted">
              Uploading manuscript…
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
        </div>
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
