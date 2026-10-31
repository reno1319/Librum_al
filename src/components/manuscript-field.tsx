"use client";

import { useEffect, useRef, useState } from "react";
import { parseDocxToDocument, repackageWithTitle } from "@/app/(public)/dashboard/books/docx-actions";
import { createClient } from "@/lib/supabase/client";
import type { ConversionWarning } from "@/lib/docx-converter";
import { fileInputClasses } from "@/lib/form-styles";
import { EbookPreview, type PreviewBuild } from "@/components/ebook-preview";
import { emptyChoices, pendingCount, type PreviewChoices } from "@/lib/docx-preview-choices";
import {
  approvalStillValid,
  approvalTickState,
  createPreviewCache,
  shouldBlockSubmit,
  submittablePath,
} from "@/lib/manuscript-approval";

// REDESIGN STEP 5 (A2): restyling only -- the picker sits in a dashed
// drop-area box and the browser's own file button is drawn as an
// outline button. Behaviour, names and every word are unchanged.
const PICKER_BOX_CLASSES =
  "flex flex-col gap-2 rounded-[4px] border border-dashed border-[#8c8472] bg-background p-4 text-sm sm:p-5";
// FIX1 (X10): `text-transparent` hides the browser's own "No file
// chosen" text, as in cover-field.tsx; "Manuscript ready" names the file.
const PICKER_INPUT_CLASSES = `${fileInputClasses} w-full max-w-full text-transparent file:mr-3 file:min-h-11 file:cursor-pointer file:rounded-[3px] file:border file:border-solid file:border-primary file:bg-surface file:px-4 file:py-2 file:text-sm file:font-semibold file:text-primary hover:file:bg-surface-hover disabled:opacity-60`;
const FORMAT_CARD_CLASSES = "flex cursor-pointer items-start gap-3 rounded-[4px] p-4";
const FORMAT_CARD_SELECTED_CLASSES = "border-2 border-primary bg-[#f4f8f5]";
const FORMAT_CARD_IDLE_CLASSES = "border border-[#c9c0ae] bg-surface";

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
const GENERIC_ERROR = "Ky dorëshkrim nuk u përpunua dot. Provoni përsëri.";
const TOO_LARGE_ERROR = "Ky dorëshkrim e kalon kufirin prej 50 MB.";
const UPLOAD_FAILED_ERROR =
  "Dorëshkrimi juaj nuk u ngarkua. Kontrolloni lidhjen dhe provoni përsëri.";
const APPROVE_FIRST_ERROR =
  "Hapni pamjen paraprake të e-librit dhe konfirmoni se libri duket mirë para se të vazhdoni.";

// W4 (Renato 31 Oct, 6a): a Word manuscript is ready to submit only
// after the author has opened the preview of THIS build and confirmed
// it. Until then the hidden "manuscriptStoragePath" stays empty, the
// wizard's Files step counts the manuscript as not ready, and a submit
// of the surrounding form (Edit Book) is stopped with a message -- so
// an unconfirmed Word book can never be saved. A directly-uploaded
// EPUB is unchanged (7b: no preview for author-made EPUBs).

export function ManuscriptField({
  bookTitle,
  bookLanguage,
  authorName,
  authorId,
  onManuscriptChange,
}: {
  // Initial seed only -- see the title-input listener effect below for
  // why this isn't the ongoing source of truth once mounted.
  bookTitle: string;
  // LIBRUM 2.0 PUBLISHING-UX-1 PART C: same "initial seed only" role as
  // bookTitle, mirrored exactly -- the ongoing source of truth, once
  // mounted, is the surrounding form's own "language" field, tracked
  // live the same way the title already is (see the shared listener
  // effect below). Optional: Edit Book does not pass this prop and has
  // no "language" form field for the listener to find, which the
  // listener already tolerates (see the null-check there) -- a
  // directly-uploaded/converted manuscript's language metadata on Edit
  // Book is unaffected, exactly as before this parameter existed.
  bookLanguage?: string;
  // The caller's already-resolved reader-facing name,
  // profiles.public_author_name ?? display_name via
  // resolvePublicAuthorName(), only ever changed from Dashboard > Profile.
  // F4 (P5): it is the FALLBACK for the book's byline. When the
  // surrounding form has a "penName" field, its trimmed value wins
  // (resolveBookByline's rule) and is tracked live exactly as the title
  // is -- see the listener effect below -- so dc:creator is the byline
  // readers see.
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
}) {
  const [mode, setMode] = useState<"epub" | "docx">("epub");
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState("");
  const [warnings, setWarnings] = useState<ConversionWarning[]>([]);
  // LIBRUM 2.0 PUBLISHING-UX-1 PART C: a persistent "Manuscript ready"
  // state, mirroring CoverField's own readyFileName -- every non-null
  // call to setHiddenPath() below already corresponds exactly to "this
  // manuscript is ready to submit" (see its own comment), so tracking
  // it there keeps this in lockstep for both EPUB and DOCX modes alike,
  // not just DOCX's pre-existing "converted successfully" message.
  const [readyName, setReadyName] = useState<string | null>(null);
  // W4: the latest Word build and the author's preview choices.
  const [build, setBuild] = useState<PreviewBuild | null>(null);
  const [choices, setChoices] = useState<PreviewChoices>(emptyChoices);
  const [appliedChoices, setAppliedChoices] = useState<PreviewChoices>(emptyChoices);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState("");
  const [previewSeen, setPreviewSeen] = useState(false);
  const [approved, setApproved] = useState(false);
  const [approveError, setApproveError] = useState("");

  const hiddenPathInputRef = useRef<HTMLInputElement>(null);
  const liveTitleRef = useRef(bookTitle);
  const liveLanguageRef = useRef(bookLanguage ?? "");
  const liveAuthorRef = useRef(authorName);
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
  // W4: the Word file the author picked, sent again for every rebuild
  // (answer 5a: Librum never keeps the Word file); the preview copy's
  // path; whether the current build is confirmed.
  const docxFileRef = useRef<File | null>(null);
  const previewPathRef = useRef<string | null>(null);
  const approvedRef = useRef(false);
  const readyNameRef = useRef<string | null>(null);
  const approvalBoxRef = useRef<HTMLDivElement>(null);
  // Audit F4: one download of the preview copy per build.
  const previewCacheRef = useRef<ReturnType<typeof createPreviewCache> | null>(null);
  // Bumped by every new Word conversion and by clearing the build; a
  // conversion whose token is no longer current is thrown away. (Not
  // requestIdRef: a title-change repackage of the previous build may
  // run while a rebuild is in flight and must not cancel it.)
  const buildTokenRef = useRef(0);

  function supabase() {
    if (!supabaseClientRef.current) {
      supabaseClientRef.current = createClient();
    }
    return supabaseClientRef.current;
  }

  function setHiddenPath(path: string | null, displayName: string | null) {
    tempPathRef.current = path;
    displayNameRef.current = path ? displayName : null;
    readyNameRef.current = path ? displayName : null;
    setReadyName(path ? displayName : null);
    publishReady();
  }

  // What the surrounding form sees: the ready path, except for a Word
  // build the author hasn't confirmed yet (W4).
  function publishReady() {
    const submittable = submittablePath(modeRef.current, tempPathRef.current, approvedRef.current);
    if (hiddenPathInputRef.current) {
      hiddenPathInputRef.current.value = submittable ?? "";
    }
    const name = readyNameRef.current;
    onManuscriptChange?.(submittable && name ? { name } : null);
  }

  function setApproval(value: boolean) {
    approvedRef.current = value;
    setApproved(value);
    if (value) setApproveError("");
    publishReady();
  }

  // A new Word build (first conversion, a rebuild, or a new file) must
  // be looked at and confirmed again.
  function resetApproval() {
    setPreviewSeen(false);
    setApproval(false);
  }

  function replacePreview(path: string | null) {
    const old = previewPathRef.current;
    previewPathRef.current = path;
    if (old !== path) previewCacheRef.current?.clear();
    if (old && old !== path) void removeTempObject(old);
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
        const result = await repackageWithTitle(
          conversionId,
          liveTitleRef.current,
          liveAuthorRef.current,
          liveLanguageRef.current || null,
        );
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

  // Live title + language: reads the surrounding form's own "title"
  // and "language" fields directly -- works identically for the
  // wizard's React-controlled inputs and Edit Book's plain
  // defaultValue-uncontrolled ones. Only a DOCX-generated manuscript
  // needs repackaging on a title/language change -- a
  // directly-uploaded EPUB's own internal metadata is whatever the
  // author's own EPUB-authoring tool already wrote; Librum has never
  // rewritten a directly-uploaded EPUB's metadata. The "language"
  // field is optional here (Edit Book passes no bookLanguage prop and
  // has no such field for this to find yet) -- when absent, the
  // listener is simply never attached and liveLanguageRef keeps its
  // seeded value, so a repackage triggered by title alone still runs,
  // unaffected.
  useEffect(() => {
    const form = hiddenPathInputRef.current?.form;
    const rawTitleInput = form?.elements.namedItem("title");
    if (!(rawTitleInput instanceof HTMLInputElement)) return;
    // Explicitly typed (not just narrowed) so the nested closure below
    // -- which TypeScript can't prove runs synchronously with this
    // check -- still sees a real HTMLInputElement rather than
    // reverting to the pre-narrowed Element | RadioNodeList union.
    const titleInput: HTMLInputElement = rawTitleInput;

    const rawLanguageInput = form?.elements.namedItem("language");
    const languageInput =
      rawLanguageInput instanceof HTMLSelectElement || rawLanguageInput instanceof HTMLInputElement
        ? rawLanguageInput
        : null;

    // F4 (P5): optional, like "language" -- absent while the Pen name
    // field is not rendered, and then the byline is simply authorName.
    const rawPenNameInput = form?.elements.namedItem("penName");
    const penNameInput = rawPenNameInput instanceof HTMLInputElement ? rawPenNameInput : null;
    const bylineFor = (input: HTMLInputElement | null) => input?.value.trim() || authorName;

    liveTitleRef.current = titleInput.value;
    if (languageInput) liveLanguageRef.current = languageInput.value;
    liveAuthorRef.current = bylineFor(penNameInput);

    function triggerRepackageIfReady() {
      if (modeRef.current === "docx" && tempPathRef.current && displayNameRef.current) {
        void repackageAndFinalize(tempPathRef.current, displayNameRef.current);
      }
    }

    function handleTitleInput() {
      liveTitleRef.current = titleInput.value;
      triggerRepackageIfReady();
    }

    function handleLanguageChange() {
      if (languageInput) liveLanguageRef.current = languageInput.value;
      triggerRepackageIfReady();
    }

    function handlePenNameInput() {
      liveAuthorRef.current = bylineFor(penNameInput);
      triggerRepackageIfReady();
    }

    titleInput.addEventListener("input", handleTitleInput);
    languageInput?.addEventListener("change", handleLanguageChange);
    penNameInput?.addEventListener("input", handlePenNameInput);
    return () => {
      titleInput.removeEventListener("input", handleTitleInput);
      languageInput?.removeEventListener("change", handleLanguageChange);
      penNameInput?.removeEventListener("input", handlePenNameInput);
    };
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
      // W4: a converted Word manuscript not yet confirmed in the preview
      // is never submitted (the hidden path is empty then, and saving
      // would silently keep the old manuscript or none).
      if (shouldBlockSubmit(modeRef.current, tempPathRef.current, approvedRef.current, pendingCountRef.current)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setApproveError(APPROVE_FIRST_ERROR);
        approvalBoxRef.current?.scrollIntoView({ block: "center" });
        return;
      }
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
      if (previewPathRef.current) void removeTempObject(previewPathRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // W4: forget the Word build and its preview.
  function clearDocxBuild() {
    buildTokenRef.current += 1;
    docxFileRef.current = null;
    replacePreview(null);
    setBuild(null);
    setChoices(emptyChoices());
    setAppliedChoices(emptyChoices());
    setPreviewOpen(false);
    setApplying(false);
    setApplyError("");
    setApproveError("");
    resetApproval();
  }

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
    clearDocxBuild();

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
    docxFileRef.current = file;
    void convertDocx(file, emptyChoices(), false);
  }

  // Uploads the Word file to a new temporary path and converts it with
  // the author's choices. The first conversion fills the field; a
  // rebuild (W4 "Apply") replaces the previous build only once the new
  // one is ready, so a failed rebuild leaves the last good one in place.
  async function convertDocx(file: File, withChoices: PreviewChoices, rebuild: boolean) {
    beginRequest();
    const myToken = ++buildTokenRef.current;
    const stale = () => myToken !== buildTokenRef.current || docxFileRef.current !== file;
    const tempDocxPath = `${authorId}/tmp/docx/${crypto.randomUUID()}.docx`;
    const displayName = file.name.replace(/\.docx$/i, "");
    const fail = (message: string) => {
      if (rebuild) {
        setApplyError(message);
      } else {
        setStatus("error");
        setErrorMessage(message);
      }
    };

    const run = (async () => {
      try {
        const { error: uploadError } = await supabase()
          .storage.from(MANUSCRIPTS_BUCKET)
          .upload(tempDocxPath, file, {
            contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          });

        if (stale()) {
          if (!uploadError) void removeTempObject(tempDocxPath);
          return;
        }
        if (uploadError) {
          console.error("ManuscriptField: DOCX upload failed:", uploadError);
          fail(UPLOAD_FAILED_ERROR);
          return;
        }

        const parsed = await parseDocxToDocument(tempDocxPath, withChoices);
        if (stale()) {
          if (parsed.success) {
            void removeTempObject(parsed.conversionId);
            void removeTempObject(parsed.previewPath);
          }
          return;
        }

        if (!parsed.success) {
          fail(parsed.error);
          return;
        }

        if (rebuild && tempPathRef.current && tempPathRef.current !== parsed.conversionId) {
          void removeTempObject(tempPathRef.current);
        }
        replacePreview(parsed.previewPath);
        resetApproval();
        setWarnings(parsed.warnings);
        setAppliedChoices(withChoices);
        setChoices(withChoices);
        setApplyError("");
        setBuild({
          previewPath: parsed.previewPath,
          cleanup: parsed.cleanup,
          chapters: parsed.chapters,
          warnings: parsed.warnings,
        });
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
        if (stale()) return;
        fail(GENERIC_ERROR);
      } finally {
        pendingCountRef.current -= 1;
        if (rebuild) setApplying(false);
      }
    })();

    inFlightRef.current = run;
    await run;
  }

  function applyChoices() {
    const file = docxFileRef.current;
    if (!file || applying) return;
    setApplying(true);
    setApproval(false);
    setApplyError("");
    void convertDocx(file, choices, true);
  }

  function downloadPreview(path: string): Promise<Blob> {
    previewCacheRef.current ??= createPreviewCache(async (p) => {
      const { data, error } = await supabase().storage.from(MANUSCRIPTS_BUCKET).download(p);
      if (error || !data) throw error ?? new Error("preview missing");
      return data;
    });
    return previewCacheRef.current.get(path);
  }

  // Audit F3: a change not yet applied takes back the author's
  // confirmation -- the book they confirmed is no longer the one they
  // expect to submit.
  function changeChoices(next: PreviewChoices) {
    setChoices(next);
    if (!approvalStillValid(approvedRef.current, pendingCount(next, appliedChoices), applying)) setApproval(false);
  }

  const tick = approvalTickState({ previewSeen, pendingChanges: pendingCount(choices, appliedChoices), applying });

  function switchMode(next: "epub" | "docx") {
    if (next === mode) return;
    modeRef.current = next;
    setMode(next);
    setStatus("idle");
    setErrorMessage("");
    setWarnings([]);
    if (tempPathRef.current) void removeTempObject(tempPathRef.current);
    setHiddenPath(null, null);
    clearDocxBuild();
  }

  return (
    <div className="flex flex-col gap-3">
      <input ref={hiddenPathInputRef} type="hidden" name="manuscriptStoragePath" />

      <fieldset className="flex flex-col gap-2 text-sm">
        <legend className="mb-1 font-semibold text-foreground">Formati i dorëshkrimit</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label
            className={`${FORMAT_CARD_CLASSES} ${mode === "epub" ? FORMAT_CARD_SELECTED_CLASSES : FORMAT_CARD_IDLE_CLASSES}`}
          >
            <input
              type="radio"
              checked={mode === "epub"}
              onChange={() => switchMode("epub")}
              className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-primary"
            />
            <span>
              <strong className="font-bold">EPUB</strong>: më i miri nëse e-libri juaj është formatuar tashmë në mënyrë profesionale
            </span>
          </label>
          <label
            className={`${FORMAT_CARD_CLASSES} ${mode === "docx" ? FORMAT_CARD_SELECTED_CLASSES : FORMAT_CARD_IDLE_CLASSES}`}
          >
            <input
              type="radio"
              checked={mode === "docx"}
              onChange={() => switchMode("docx")}
              className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-primary"
            />
            <span>
              <strong className="font-bold">DOCX</strong>: Librum e kthen në EPUB që përshtatet me ekranin
            </span>
          </label>
        </div>
      </fieldset>

      {mode === "epub" ? (
        <div className="flex flex-col gap-2">
          <label className={PICKER_BOX_CLASSES}>
            <span className="font-semibold text-foreground">
              {status === "success" ? "Zëvendësoni dorëshkrimin" : "Skedari i dorëshkrimit"}
            </span>
            <input
              type="file"
              accept=".epub,application/epub+zip"
              className={PICKER_INPUT_CLASSES}
              disabled={status === "converting"}
              onChange={(e) => handleEpubChange(e.target.files?.[0] ?? null)}
            />
            <span className="text-sm text-muted">
              EPUB · deri në 50 MB.
            </span>
          </label>

          {status === "converting" && (
            <p role="status" className="text-sm text-muted">
              Po ngarkohet dorëshkrimi…
            </p>
          )}

          {status === "success" && readyName && (
            <p role="status" className="text-sm font-semibold text-primary">
              Dorëshkrimi gati: {readyName}
            </p>
          )}

          {status === "error" && (
            <p
              role="alert"
              className="rounded-card border-l-4 border-red-600 bg-surface px-3 py-2 text-sm text-red-800"
            >
              {errorMessage}
            </p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <label className={PICKER_BOX_CLASSES}>
            <span className="font-semibold text-foreground">
              {status === "success" ? "Zëvendësoni dorëshkrimin" : "Skedari i dorëshkrimit"}
            </span>
            <input
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              className={PICKER_INPUT_CLASSES}
              disabled={status === "converting"}
              onChange={(e) => handleDocxChange(e.target.files?.[0] ?? null)}
            />
            <span className="text-sm text-muted">DOCX · deri në 50 MB.</span>
          </label>
          <p className="text-sm text-muted">
            Librum ruan strukturën e zakonshme të dorëshkrimit: titujt, paragrafët,
            formatimin bazë, listat, lidhjet dhe imazhet e pranuara. Faqosja e ndërlikuar
            e Word-it mund të duhet kontrolluar pas kthimit.
          </p>

          {status === "converting" && (
            <p role="status" className="text-sm text-muted">
              Po kthehet dorëshkrimi…
            </p>
          )}

          {status === "error" && (
            <p
              role="alert"
              className="rounded-card border-l-4 border-red-600 bg-surface px-3 py-2 text-sm text-red-800"
            >
              {errorMessage}
            </p>
          )}

          {status === "success" && (
            <div role="status" className="rounded-card border-l-4 border-primary bg-surface px-3 py-2 text-sm">
              <p className="font-medium text-foreground">
                Dorëshkrimi gati{readyName ? `: ${readyName}` : ""}
              </p>
              <p className="mt-1 text-muted">
                EPUB-i i krijuar kaloi kontrollin e Librum. Shikojeni e-librin
                para publikimit.
              </p>
              {warnings.length > 0 && (
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
                  {warnings.map((w) => (
                    <li key={w.code}>{w.message}</li>
                  ))}
                </ul>
              )}
              {build && (
                <div ref={approvalBoxRef} className="mt-3 flex flex-col gap-2">
                  <button
                    type="button"
                    className="focus-ring min-h-11 self-start rounded-[3px] bg-primary px-4 font-semibold text-white"
                    onClick={() => setPreviewOpen(true)}
                  >
                    Hap pamjen paraprake
                  </button>
                  <label className={`flex items-start gap-2 ${tick.disabled ? "opacity-60" : ""}`}>
                    <input
                      type="checkbox"
                      className="focus-ring mt-0.5 h-5 w-5 shrink-0 accent-primary"
                      checked={approved}
                      disabled={tick.disabled}
                      onChange={(e) => setApproval(e.target.checked)}
                    />
                    <span>
                      E kontrollova pamjen paraprake dhe libri duket si duhet.
                      {tick.reason && <span className="block text-xs text-muted">{tick.reason}</span>}
                    </span>
                  </label>
                  {approveError && (
                    <p role="alert" className="text-sm text-red-800">
                      {approveError}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

          {previewOpen && build && (
            <EbookPreview
              build={build}
              choices={choices}
              appliedChoices={appliedChoices}
              onChoicesChange={changeChoices}
              onApply={applyChoices}
              applying={applying}
              applyError={applyError}
              onApprove={() => {
                setApproval(true);
                setPreviewOpen(false);
              }}
              onClose={() => setPreviewOpen(false)}
              onLoaded={() => setPreviewSeen(true)}
              download={downloadPreview}
            />
          )}
        </div>
      )}
    </div>
  );
}
