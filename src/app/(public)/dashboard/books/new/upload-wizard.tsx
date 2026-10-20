"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { createBook } from "../actions";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { formatAllMinorUnits } from "@/lib/all-money";
import {
  MAXIMUM_CATALOG_PRICE_ALL,
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  formatCatalogPriceLabel,
} from "@/lib/catalog-price";
import { GENRES } from "@/lib/genres";
import { LANGUAGES } from "@/lib/languages";
import { resolvePublishReadiness } from "@/lib/publish-readiness";
import {
  canAdvanceFromBookDetails,
  canAdvanceFromFiles,
  resolveWizardPricing,
  type WizardPriceMode,
} from "./wizard-validation";
import { fieldErrorClasses, formControlClassesFor } from "@/lib/form-styles";
import {
  FUTURE_DATE_MESSAGE,
  INVALID_ISBN_MESSAGE,
  isFutureDateString,
  isValidIsbn,
} from "@/lib/book-identifiers";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { buttonClasses } from "@/components/ui/button";
import { ManuscriptField } from "@/components/manuscript-field";
import { CoverField } from "@/components/cover-field";
import { RIGHTS_BASES, RIGHTS_STATEMENTS } from "@/lib/rights-statements";
import type { RightsBasis, Series } from "@/lib/types";

// LIBRUM 2.0 PUBLISHING-UX-1 PART C: redesigned step order and content --
// "Book Details" now comes FIRST (Title/Language/Genre, the fields the
// rest of the flow and EPUB metadata threading depend on), then
// "Cover & Manuscript", then the price. Every field stays mounted across
// steps (display toggled, not unmounted) so uncontrolled/controlled
// values -- and CoverField/ManuscriptField's own upload state -- survive
// going back and forth, exactly as the pre-Part-C wizard already relied
// on.
//
// REDESIGN STEP 5 (A2): three steps, named in Renato's own words
// (Details, Manuscript & cover, Price). The old fourth "Review &
// Publish" step is gone (his D1): its Readiness block moved to the
// bottom of the Price step, and its summary list was dropped (Q6). The
// Price step starts with a Paid / Free choice (D3) and has a side panel
// with the existing earnings box and a "How readers will see it" card
// (D5). Nothing is saved automatically (D2).
//
// This is still one atomic submission to createBook(): nothing is saved
// to the server until a final-step button is pressed. What's new is
// that button choice: "Save as draft" always sends intent=draft (a
// draft is created, nothing more); "Publish book" sends intent=publish,
// which createBook() (see actions.ts's PUBLISHING-UX-1 PART B addition)
// always creates the draft FIRST and only then attempts the real
// publish gate -- so even a blocked publish (e.g. a paid book before
// payouts are set up) leaves the author with a safely saved draft, not
// a failed submission. See SaveButtons below for the native
// name="intent" value="draft"|"publish" submitter mechanism.
const STEPS = ["Details", "Manuscript & cover", "Price"];

// Client-side-only bounds, purely a UX nicety mirroring actions.ts's own
// authoritative SUBTITLE_MAX_LENGTH/PUBLISHER_MAX_LENGTH/EDITION_MAX_LENGTH
// constants (not imported -- those are module-private to a "use server"
// file this task's own instructions protect from edits). A mismatch here
// has no security implication: the server re-validates and rejects an
// over-limit value independently, regardless of what a client sends.
const SUBTITLE_MAX_LENGTH = 300;
const PUBLISHER_MAX_LENGTH = 200;
const EDITION_MAX_LENGTH = 100;
// F4: books.pen_name's own check (1-120 characters) and the Translator
// field's server bound. Over-long input that bypasses maxLength ends in
// the existing save-failure (pen name) or contributor (translator)
// message; there is no sentence of its own (Renato's Q6 = a).
const PEN_NAME_MAX_LENGTH = 120;
const TRANSLATOR_MAX_LENGTH = 120;

// REDESIGN STEP 5: Q7's wording -- the free-ebook "0" option is gone
// from the paid price's error, hint and earnings sentences, because Free
// is now its own choice and 0 is not accepted under Paid.
const PAID_PRICE_ERROR = `Enter a price in lek: a whole number from ${MINIMUM_PAID_CATALOG_PRICE_ALL} to ${MAXIMUM_CATALOG_PRICE_ALL}.`;

// FIX1 (X8): Renato's W-B wording, one message beside each field.
const TITLE_ERROR = "Add a title.";
const LANGUAGE_ERROR = "Choose a language.";
const GENRE_ERROR = "Choose a genre.";
const FILES_ERROR = "Add both a cover image and a manuscript file to continue.";
// FIX1 (X16): shown in Readiness while the description is empty. True
// here: Publish book always saves the draft before the publish check.
const MISSING_DESCRIPTION_LINE =
  "Add a description before publishing. Your book will still be saved as a draft.";
// F4 (P3): shown under the Rights choice when Publish book is pressed
// without one, and as a Readiness blocker until one is chosen.
const MISSING_RIGHTS_LINE = "Choose the rights before publishing.";

// FIX1 (X8): a field's own message, tied to the field by id.
function FieldError({ id, message }: { id: string; message: string }) {
  if (!message) return null;
  return (
    <span id={id} className={fieldErrorClasses}>
      {message}
    </span>
  );
}

// The same A2 classes the dashboard (step 4) uses for its boxes and
// text links, kept local as the dashboard keeps its own.
const CARD_CLASSES = "rounded-[4px] border border-border bg-surface";
const BOX_LABEL_CLASSES = "text-[0.8125rem] uppercase tracking-[0.06em] text-muted";
const TEXT_LINK_CLASSES =
  "focus-ring w-fit rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";

function SaveButtons() {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-col items-end gap-2">
      {pending && (
        <p role="status" className="text-sm text-muted">
          Saving…
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-3">
        <button
          type="submit"
          name="intent"
          value="draft"
          disabled={pending}
          className={buttonClasses("outline", "md", "min-h-11 disabled:cursor-not-allowed disabled:opacity-60")}
        >
          Save as draft
        </button>
        <button
          type="submit"
          name="intent"
          value="publish"
          disabled={pending}
          className={buttonClasses("primary", "md", "min-h-11 disabled:cursor-not-allowed disabled:opacity-60")}
        >
          {/* ADMIN-3-REVIEW (B): a new book has no approval yet. */}
          Send for review
        </button>
      </div>
    </div>
  );
}

export function UploadWizard({
  series,
  authorName,
  authorId,
  paidPublishingAvailable,
  penNameAvailable,
  penNameSuggestions = [],
  rightsAvailable,
}: {
  series: Series[];
  authorName: string;
  authorId: string;
  // F4 (D1/D2/D3): whether the database has the pen name column and the
  // rights table yet (getCatalogSchemaFeatures(), evaluated by page.tsx).
  // Rendering only: without them the Pen name field and the Rights
  // choice are not shown, and the server refuses Publish on its own.
  penNameAvailable: boolean;
  // PEN-NAMES-1 (10a): the author's other pen names, suggested under the
  // box (the default is the blank box itself).
  penNameSuggestions?: string[];
  rightsAvailable: boolean;
  // LIBRUM 2.0 PUBLISHING-UX-1 PART C / PR-G: display-only context for
  // the Price step's readiness section -- never a pre-submit gate.
  // Publish book can still be pressed even when this is false;
  // performPublish() (actions.ts) remains the one real, server-side
  // enforcement point, exactly as before this prop existed.
  //
  // It arrives as a PROP and must keep arriving as one: this is a client
  // component, the capability lives in @/lib/paid-readiness, and that
  // module is server-only. See page.tsx, which evaluates it.
  paidPublishingAvailable: boolean;
}) {
  const [step, setStep] = useState(1);
  // FIX1 (X8): no single sentence at the top any more. Each step shows
  // its messages beside the fields they belong to, once the author has
  // pressed Next (or a final button) on that step; a required field's
  // message clears as soon as it is filled, because it is derived from
  // the live value, not stored.
  const [showDetailErrors, setShowDetailErrors] = useState(false);
  const [showFilesError, setShowFilesError] = useState(false);
  const [priceError, setPriceError] = useState("");

  // LIBRUM 2.0 PRODUCT-5 COVER-1: no longer a File -- CoverField now
  // uploads directly to Storage and maintains its own small path
  // reference internally (see its own top-of-file comment), reporting
  // only display metadata here. PART C: now also carries previewUrl, so
  // the Price step's "How readers will see it" card can show an actual
  // thumbnail without a second upload/preview implementation.
  const [cover, setCover] = useState<{ name: string; previewUrl: string } | null>(null);
  // LIBRUM 2.0 PRODUCT-5 CB-1: no longer a File -- ManuscriptField now
  // maintains a small Storage-path reference internally (see its own
  // top-of-file comment) and reports only display metadata here.
  const [manuscript, setManuscript] = useState<{ name: string } | null>(null);
  const [title, setTitle] = useState("");
  // LIBRUM 2.0 PUBLISHING-UX-1 PART C FINAL-VERIFICATION CORRECTION:
  // defaults to "sq" (Albanian) -- Librum is an Albanian-market
  // platform, so the common case is zero extra clicks, not a forced
  // choice like Genre (which has no sensible default). Still a real,
  // required, submitted <select name="language">, so an author who
  // wants a different LANGUAGES entry changes it same as any other
  // field -- this default never bypasses canAdvanceFromBookDetails()'s
  // own real "language must be present" check, it just starts true.
  const [language, setLanguage] = useState("sq");
  const [genre, setGenre] = useState("");
  // LIBRUM 2.0 PUBLISHING-UX-1 PART C: promoted from uncontrolled to
  // controlled -- deliberately just these two fields, not a full
  // controlled-form rewrite (subtitle/isbn/publisher/edition/original
  // publication date/series stay exactly as uncontrolled as before) --
  // so the readiness section can reuse resolvePublishReadiness() with
  // real live values instead of reimplementing its logic.
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  // FIX1 (X9): promoted to controlled for the same reason -- the ISBN
  // and date checks read the live value. Each field's message also
  // shows once the author leaves that field.
  const [isbn, setIsbn] = useState("");
  const [originalPublicationDate, setOriginalPublicationDate] = useState("");
  const [isbnTouched, setIsbnTouched] = useState(false);
  const [dateTouched, setDateTouched] = useState(false);
  // REDESIGN STEP 5 (D3): Paid is chosen when the page opens, with an
  // empty box -- the old hidden default of "0" (= free) is gone. The
  // paid box keeps its own value, so switching Free -> Paid shows what
  // the author typed before, never a carried-over 0.
  const [priceMode, setPriceMode] = useState<WizardPriceMode>("paid");
  const [paidPrice, setPaidPrice] = useState("");
  // F4 (P1/P5): controlled so "How readers will see it" shows the byline
  // live: the typed pen name, else the author name.
  const [penName, setPenName] = useState("");
  // F4 (P3): nothing is chosen when the page opens (no preselect).
  const [rightsBasis, setRightsBasis] = useState<RightsBasis | "">("");
  const [rightsError, setRightsError] = useState("");

  // Moves keyboard and screen-reader focus to the new step's (visually
  // hidden) heading on every step change, but not on first render.
  const stepHeadingRef = useRef<HTMLHeadingElement>(null);
  const priceInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const languageSelectRef = useRef<HTMLSelectElement>(null);
  const genreSelectRef = useRef<HTMLSelectElement>(null);
  const isbnInputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const moreDetailsRef = useRef<HTMLDetailsElement>(null);
  const firstRightsRadioRef = useRef<HTMLInputElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    stepHeadingRef.current?.focus();
  }, [step]);

  const titleError = title.trim() ? "" : TITLE_ERROR;
  const languageError = language.trim() ? "" : LANGUAGE_ERROR;
  const genreError = genre.trim() ? "" : GENRE_ERROR;
  const isbnError = isbn.trim() && !isValidIsbn(isbn) ? INVALID_ISBN_MESSAGE : "";
  const dateError = isFutureDateString(originalPublicationDate) ? FUTURE_DATE_MESSAGE : "";
  const shownTitleError = showDetailErrors ? titleError : "";
  const shownLanguageError = showDetailErrors ? languageError : "";
  const shownGenreError = showDetailErrors ? genreError : "";
  const shownIsbnError = showDetailErrors || isbnTouched ? isbnError : "";
  const shownDateError = showDetailErrors || dateTouched ? dateError : "";
  const filesReady = canAdvanceFromFiles({ coverReady: !!cover, manuscriptReady: !!manuscript });
  const shownFilesError = showFilesError && !filesReady ? FILES_ERROR : "";

  // Step 1 passes only when every field on it is valid. On a failure
  // every message shows at once and focus goes to the first field with
  // one, opening "Additional book details" when that field is inside.
  function detailsAreValid(): boolean {
    const valid =
      canAdvanceFromBookDetails({ title, language, genre }) && !isbnError && !dateError;
    if (valid) return true;
    setShowDetailErrors(true);
    if (titleError) titleInputRef.current?.focus();
    else if (languageError) languageSelectRef.current?.focus();
    else if (genreError) genreSelectRef.current?.focus();
    else {
      if (moreDetailsRef.current) moreDetailsRef.current.open = true;
      (isbnError ? isbnInputRef : dateInputRef).current?.focus();
    }
    return false;
  }

  function goNext() {
    if (step === 1 && !detailsAreValid()) return;
    if (step === 2 && !filesReady) {
      setShowFilesError(true);
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length));
  }

  function goBack() {
    setStep((s) => Math.max(s - 1, 1));
  }

  // A done step in the step list goes straight back to that step; no
  // validation is needed to go back (W1). Later steps are not links.
  function goToDoneStep(target: number) {
    if (target >= step) return;
    setStep(target);
  }

  const byline = (penNameAvailable ? penName.trim() : "") || authorName;

  const pricing = resolveWizardPricing({ mode: priceMode, paidPrice });
  const { priceValid, isFreeBook, priceAll, grossMinor, feeMinor, earningsMinor } = pricing;

  // W6: an invalid paid price blocks BOTH final buttons before anything
  // is sent. This is a submit handler, not a disabled= on the buttons:
  // SaveButtons stays disabled by `pending` only. The server-side price
  // checks in actions.ts are unchanged and still decide on their own.
  //
  // FIX1 (X8/X9): the message now sits under the price box. The step-1
  // checks are re-run too, as a guard only: step 1 cannot be left with
  // an invalid field, so this sends the author back to it only if that
  // ever changed.
  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    if (!canAdvanceFromBookDetails({ title, language, genre }) || isbnError || dateError) {
      event.preventDefault();
      setStep(1);
      setShowDetailErrors(true);
      return;
    }
    // F4 (P3): Publish book needs a rights choice; Save as draft never
    // does. Checked like the price, before anything is sent.
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const publishing = submitter instanceof HTMLButtonElement && submitter.value === "publish";
    const rightsMissing = publishing && rightsAvailable && rightsBasis === "";
    if (rightsMissing) setRightsError(MISSING_RIGHTS_LINE);
    if (!pricing.canSubmit) {
      event.preventDefault();
      setPriceError(PAID_PRICE_ERROR);
      priceInputRef.current?.focus();
      return;
    }
    if (rightsMissing) {
      event.preventDefault();
      firstRightsRadioRef.current?.focus();
    }
  }

  // ALL-WIRING-2: readiness is previewed against the price the author
  // has chosen SO FAR, so an unparsed/empty paid field is genuinely "no
  // ALL price yet" and reports missingAllPrice -- the same answer
  // performPublish would give for such a row. `null`, never 0: passing
  // 0 would preview a free book and hide the blocker.
  const readiness = resolvePublishReadiness({
    book: {
      description,
      keywords,
      price_all: priceValid ? priceAll : null,
      cover_path: cover ? "pending" : null,
    },
    paidPublishingAvailable,
    // F4 (D3): with the rights table missing, no choice can be made and
    // the server refuses Publish, so the book is never "ready" here.
    hasRightsDeclaration: rightsAvailable && rightsBasis !== "",
  });

  return (
    <form action={createBook} onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6">
      <ol aria-label="Steps" className="grid grid-cols-3 gap-2 sm:gap-3">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? "step" : undefined}
            className={`flex flex-col gap-0.5 border-t-4 pt-3 ${
              step === i + 1 ? "border-accent" : step > i + 1 ? "border-primary" : "border-border"
            }`}
          >
            {step > i + 1 ? (
              <>
                <span className="text-[0.8125rem] font-bold text-[#2f6b4f]">✓ Step {i + 1}</span>
                <button
                  type="button"
                  onClick={() => goToDoneStep(i + 1)}
                  className="focus-ring w-fit rounded-sm text-left text-sm font-semibold text-primary underline underline-offset-2 hover:decoration-2"
                >
                  {label}
                </button>
              </>
            ) : step === i + 1 ? (
              <>
                {/* The mockup's dark brass (#8a6d12), darkened a step to
                    5.0:1 on cream so 13px text passes AA. */}
                <span className="text-[0.8125rem] font-bold text-[#806511]">
                  Step {i + 1} of {STEPS.length}
                </span>
                <span className="text-sm font-bold text-primary">{label}</span>
              </>
            ) : (
              <>
                <span className="text-[0.8125rem] font-bold text-muted">Step {i + 1}</span>
                <span className="text-sm font-semibold text-muted">{label}</span>
              </>
            )}
          </li>
        ))}
      </ol>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22.5rem] lg:items-start lg:gap-8">
        <section
          aria-labelledby="wizard-step-heading"
          className={`${CARD_CLASSES} flex min-w-0 flex-col gap-6 p-5 sm:p-8`}
        >
          <h2
            id="wizard-step-heading"
            ref={stepHeadingRef}
            tabIndex={-1}
            className="sr-only"
          >
            {STEPS[step - 1]}
          </h2>

          {/* Step 1: Details */}
          <div className={step === 1 ? "flex flex-col gap-4" : "hidden"}>
            <label className="flex flex-col gap-1 text-sm">
              Title
              <input
                ref={titleInputRef}
                name="title"
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-invalid={shownTitleError ? true : undefined}
                aria-describedby={shownTitleError ? "wizard-title-error" : undefined}
                className={formControlClassesFor(!!shownTitleError)}
              />
              <FieldError id="wizard-title-error" message={shownTitleError} />
            </label>

            {/* F4 (P1, Q1 = a): directly under Title, only once the
                database can store it. */}
            {penNameAvailable && (
              <label className="flex flex-col gap-1 text-sm">
                Pen name (optional)
                <input
                  name="penName"
                  type="text"
                  maxLength={PEN_NAME_MAX_LENGTH}
                  value={penName}
                  onChange={(e) => setPenName(e.target.value)}
                  list={penNameSuggestions.length > 0 ? "wizard-pen-name-suggestions" : undefined}
                  autoComplete="off"
                  className={formControlClassesFor(false)}
                />
                {penNameSuggestions.length > 0 && (
                  <datalist id="wizard-pen-name-suggestions">
                    {penNameSuggestions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                )}
                {authorName && (
                  <span className="text-sm text-muted">
                    Leave blank to use your author name, {authorName}.
                  </span>
                )}
                {/* PEN-NAMES-1 (10a): a new name creates a pen name with
                    its own Author Page. */}
                <span className="text-sm text-muted">
                  A new name becomes a new pen name with its own author page.
                  {penNameSuggestions.length > 0 && " Your pen names are suggested as you type."}
                </span>
              </label>
            )}

            <label className="flex flex-col gap-1 text-sm">
              Language
              <select
                name="language"
                ref={languageSelectRef}
                required
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                aria-invalid={shownLanguageError ? true : undefined}
                aria-describedby={shownLanguageError ? "wizard-language-error" : undefined}
                className={formControlClassesFor(!!shownLanguageError)}
              >
                <option value="" disabled>
                  Choose a language
                </option>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <FieldError id="wizard-language-error" message={shownLanguageError} />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Genre
              <select
                name="genre"
                ref={genreSelectRef}
                required
                value={genre}
                onChange={(e) => setGenre(e.target.value)}
                aria-invalid={shownGenreError ? true : undefined}
                aria-describedby={shownGenreError ? "wizard-genre-error" : undefined}
                className={formControlClassesFor(!!shownGenreError)}
              >
                <option value="" disabled>
                  Choose a genre
                </option>
                {GENRES.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
              <FieldError id="wizard-genre-error" message={shownGenreError} />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Subtitle (optional)
              <input
                name="subtitle"
                type="text"
                maxLength={SUBTITLE_MAX_LENGTH}
                className={formControlClassesFor(false)}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Description
              <textarea
                name="description"
                rows={4}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className={formControlClassesFor(false)}
              />
              <span className="text-sm text-muted">
                A couple of sentences or more helps readers decide.
              </span>
            </label>

            <details ref={moreDetailsRef} className="rounded-card border border-border px-4 py-3">
              <summary className="cursor-pointer text-sm font-medium text-foreground">
                Additional book details
              </summary>
              <div className="mt-4 flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                  ISBN (optional)
                  <input
                    ref={isbnInputRef}
                    name="isbn"
                    type="text"
                    placeholder="e.g. 978-3-16-148410-0"
                    value={isbn}
                    onChange={(e) => setIsbn(e.target.value)}
                    onBlur={() => setIsbnTouched(true)}
                    aria-invalid={shownIsbnError ? true : undefined}
                    aria-describedby={shownIsbnError ? "wizard-isbn-error" : undefined}
                    className={formControlClassesFor(!!shownIsbnError)}
                  />
                  <FieldError id="wizard-isbn-error" message={shownIsbnError} />
                  <span className="text-sm text-muted">
                    Only if you already own one — Librum doesn&apos;t issue or
                    register ISBNs. Leave blank to skip.
                  </span>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Publisher (optional)
                  <input
                    name="publisher"
                    type="text"
                    maxLength={PUBLISHER_MAX_LENGTH}
                    className={formControlClassesFor(false)}
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Edition (optional)
                  <input
                    name="edition"
                    type="text"
                    placeholder="e.g. 2nd edition"
                    maxLength={EDITION_MAX_LENGTH}
                    className={formControlClassesFor(false)}
                  />
                </label>

                {/* F4 (P2, Q2 = a): saved as one contributor with the
                    Translator role; edited or removed later under People
                    on the Edit page. */}
                <label className="flex flex-col gap-1 text-sm">
                  Translator (optional)
                  <input
                    name="translator"
                    type="text"
                    maxLength={TRANSLATOR_MAX_LENGTH}
                    className={formControlClassesFor(false)}
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Originally published (optional)
                  <input
                    ref={dateInputRef}
                    name="originalPublicationDate"
                    type="date"
                    value={originalPublicationDate}
                    onChange={(e) => setOriginalPublicationDate(e.target.value)}
                    onBlur={() => setDateTouched(true)}
                    aria-invalid={shownDateError ? true : undefined}
                    aria-describedby={shownDateError ? "wizard-date-error" : undefined}
                    className={formControlClassesFor(!!shownDateError)}
                  />
                  <FieldError id="wizard-date-error" message={shownDateError} />
                  <span className="text-sm text-muted">
                    Only if this edition was first published elsewhere before
                    arriving on Librum.
                  </span>
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  Keywords (optional)
                  <input
                    name="keywords"
                    type="text"
                    value={keywords}
                    onChange={(e) => setKeywords(e.target.value)}
                    placeholder="e.g. space opera, first contact, hard sci-fi"
                    className={formControlClassesFor(false)}
                  />
                  <span className="text-sm text-muted">
                    Comma-separated. Helps readers find your book by terms beyond
                    its genre — up to 15.
                  </span>
                </label>

                {series.length === 0 && (
                  <p className="text-sm text-muted">
                    Want to group this with other books as a series?{" "}
                    {/* FIX1 (X11): a new tab, so nothing typed here is lost. */}
                    <Link
                      href="/dashboard/series"
                      target="_blank"
                      rel="noopener"
                      className="focus-ring rounded-sm underline"
                    >
                      Create a series first
                      <span className="sr-only"> (opens in a new tab)</span>
                    </Link>
                    , then come back here.
                  </p>
                )}

                {series.length > 0 && (
                  <div className="flex gap-3">
                    <label className="flex flex-1 flex-col gap-1 text-sm">
                      Series (optional)
                      <select name="seriesId" defaultValue="" className={formControlClassesFor(false)}>
                        <option value="">None</option>
                        {series.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      Position
                      <input
                        name="seriesPosition"
                        type="number"
                        min="1"
                        step="1"
                        placeholder="1"
                        className={`w-24 ${formControlClassesFor(false)}`}
                      />
                    </label>
                  </div>
                )}
              </div>
            </details>
          </div>

          {/* Step 2: Manuscript & cover */}
          <div className={step === 2 ? "flex flex-col gap-6" : "hidden"}>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <CoverField authorId={authorId} onCoverChange={setCover} />
                {/* FIX1 (X10): the tip moved here from the Tips box. */}
                <p className="text-sm text-muted">
                  Covers work best as a portrait image, at least 1000px tall.
                </p>
              </div>

              <ManuscriptField
                bookTitle={title}
                bookLanguage={language}
                authorName={authorName}
                authorId={authorId}
                onManuscriptChange={setManuscript}
              />

              <p role="status" className="text-sm text-muted">
                {[cover, manuscript].filter(Boolean).length} of 2 files ready.
              </p>

              {/* FIX1 (X8): the existing sentence, under the file fields. */}
              {shownFilesError && (
                <p role="alert" className={fieldErrorClasses}>
                  {shownFilesError}
                </p>
              )}

              <p className="text-sm text-muted">
                Readers can preview approximately the first 10% of your ebook —
                generated automatically, no extra steps needed.
              </p>
            </div>

            <aside className="rounded-card border border-dashed border-border px-4 py-3 text-xs text-muted">
              <p className="font-medium text-foreground">Tips</p>
              <ul className="mt-1 flex flex-col gap-1 pl-4 list-disc">
                <li>
                  You can replace either file later from your dashboard before —
                  or after — publishing.
                </li>
              </ul>
            </aside>
          </div>

          {/* Step 3: Price */}
          <div className={step === 3 ? "flex flex-col gap-6" : "hidden"}>
            {/* D3: Paid / Free. The radios' own name ("pricing") is a
                display control only -- createBook reads fields by name
                and never reads it; the price it needs still arrives in
                the "price" field (the box under Paid, a fixed "0" under
                Free). */}
            <fieldset className="flex flex-col gap-3">
              <legend className="sr-only">{STEPS[2]}</legend>
              {(
                [
                  ["paid", "Paid"],
                  ["free", "Free"],
                ] as const
              ).map(([mode, label]) => (
                <label
                  key={mode}
                  className={`flex cursor-pointer items-center gap-3.5 rounded-[4px] p-4 ${
                    priceMode === mode
                      ? "border-2 border-primary bg-[#f4f8f5]"
                      : "border border-[#c9c0ae] bg-surface"
                  }`}
                >
                  <input
                    type="radio"
                    name="pricing"
                    value={mode}
                    checked={priceMode === mode}
                    onChange={() => {
                      setPriceMode(mode);
                      setPriceError("");
                    }}
                    onKeyDown={(e) => {
                      // Enter on a radio must not submit the form as
                      // "Save as draft" (the first submit button).
                      if (e.key === "Enter") e.preventDefault();
                    }}
                    className="focus-ring h-5 w-5 shrink-0 accent-primary"
                  />
                  <span className="font-bold text-foreground">{label}</span>
                </label>
              ))}
            </fieldset>

            {priceMode === "paid" ? (
              // ALL-WIRING-2: an ALL text field with a decimal keyboard, not
              // a USD number field -- see the Publishing Studio's own copy of
              // this comment for why `type="number"` made the comma decimal
              // form unreachable and advertised a fractional lek price the
              // catalog cannot store.
              <label className="flex flex-col gap-1 text-sm">
                Price (ALL)
                <span
                  className={`flex w-full max-w-[17.5rem] items-stretch overflow-hidden rounded-[4px] border bg-surface focus-within:shadow-[var(--focus-ring)] ${
                    priceError ? "border-red-700" : "border-[#8c8472]"
                  }`}
                >
                  <input
                    ref={priceInputRef}
                    name="price"
                    type="text"
                    inputMode="decimal"
                    value={paidPrice}
                    onChange={(e) => {
                      setPaidPrice(e.target.value);
                      // The price error belongs to the old value.
                      setPriceError("");
                    }}
                    onKeyDown={(e) => {
                      // Enter in the price box must not submit the form as
                      // "Save as draft" (the first submit button).
                      if (e.key === "Enter") e.preventDefault();
                    }}
                    aria-invalid={priceError ? true : undefined}
                    aria-describedby={priceError ? "wizard-price-error" : undefined}
                    className="min-w-0 flex-1 border-0 bg-transparent px-3 py-2.5 text-lg outline-none"
                  />
                  <span
                    aria-hidden="true"
                    className="flex items-center bg-surface-hover px-4 font-bold text-foreground"
                  >
                    ALL
                  </span>
                </span>
                {/* FIX1 (X8): the price message, under the price box. */}
                <FieldError id="wizard-price-error" message={priceError} />
                <span className="text-sm text-muted">
                  Whole lek: {MINIMUM_PAID_CATALOG_PRICE_ALL} to{" "}
                  {MAXIMUM_CATALOG_PRICE_ALL}. Librum takes a {PLATFORM_FEE_PERCENT}%
                  platform fee — you keep the rest of every sale.
                </span>
              </label>
            ) : (
              <input type="hidden" name="price" value="0" />
            )}

            {/* D1: the old Review step's readiness block, same conditions
                and words, just above the buttons. Its missing-price line
                is no longer reachable (an invalid paid price is blocked
                before submit) and is not rendered. */}
            <div className="rounded-card border border-border bg-background p-4 text-sm">
              <p className="text-xs font-medium uppercase tracking-wide text-muted">Readiness</p>
              {/* PR-G: replaces "Finish payout setup to publish paid books."
                  -- there is no payout setup to finish, and nothing an author
                  can do here changes this. Stays CONDITIONAL, never a
                  hardcoded line: with PAID_PUBLISHING_MODE set on the
                  protected staging deployment it correctly disappears. */}
              {readiness.missingDescription && (
                <p className="mt-2 text-red-800">{MISSING_DESCRIPTION_LINE}</p>
              )}
              {rightsAvailable && readiness.missingRights && (
                <p className="mt-2 text-red-800">{MISSING_RIGHTS_LINE}</p>
              )}
              {readiness.paidPublishingBlocked && (
                <p className="mt-2 text-red-800">
                  Paid publishing hasn&apos;t launched yet. Your book will still
                  be saved as a draft.
                </p>
              )}
              {readiness.recommended.filter((item) => !item.done).length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 pl-4 text-xs text-muted list-disc">
                  {readiness.recommended
                    .filter((item) => !item.done)
                    .map((item) => (
                      <li key={item.label}>{item.label}</li>
                    ))}
                </ul>
              )}
              {!readiness.missingAllPrice &&
                !readiness.missingDescription &&
                !readiness.missingRights &&
                !readiness.paidPublishingBlocked &&
                readiness.recommended.every((item) => item.done) && (
                <p className="mt-2 text-muted">Looks good — ready to send for review.</p>
              )}
            </div>

            {/* F4 (P3, Q3 = a): the rights choice, between Readiness and
                the buttons. The sentences come from RIGHTS_STATEMENTS,
                never retyped; the cards are the Paid / Free cards above,
                with the same Enter guard. Nothing is preselected. */}
            {rightsAvailable && (
              <fieldset
                aria-describedby={rightsError ? "wizard-rights-error" : undefined}
                className={`flex flex-col gap-3 rounded-[4px] ${
                  rightsError ? "outline-2 outline-offset-4 outline-red-700" : ""
                }`}
              >
                <legend className="mb-3 font-bold text-foreground">Rights</legend>
                {RIGHTS_BASES.map((basis, index) => (
                  <label
                    key={basis}
                    className={`flex cursor-pointer items-center gap-3.5 rounded-[4px] p-4 ${
                      rightsBasis === basis
                        ? "border-2 border-primary bg-[#f4f8f5]"
                        : "border border-[#c9c0ae] bg-surface"
                    }`}
                  >
                    <input
                      ref={index === 0 ? firstRightsRadioRef : undefined}
                      type="radio"
                      name="rightsBasis"
                      value={basis}
                      checked={rightsBasis === basis}
                      onChange={() => {
                        setRightsBasis(basis);
                        setRightsError("");
                      }}
                      onKeyDown={(e) => {
                        // Enter on a radio must not submit the form as
                        // "Save as draft" (the first submit button).
                        if (e.key === "Enter") e.preventDefault();
                      }}
                      className="focus-ring h-5 w-5 shrink-0 accent-primary"
                    />
                    <span className="text-foreground">{RIGHTS_STATEMENTS[basis].text}</span>
                  </label>
                ))}
                <FieldError id="wizard-rights-error" message={rightsError} />
              </fieldset>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-surface-hover pt-6">
            {step > 1 ? (
              <button
                type="button"
                onClick={goBack}
                className="focus-ring min-h-11 rounded-sm text-sm font-semibold text-primary underline underline-offset-2 hover:decoration-2"
              >
                <span aria-hidden="true">&larr; </span>Back
              </button>
            ) : (
              <span />
            )}

            {step < STEPS.length ? (
              <button type="button" onClick={goNext} className={buttonClasses("primary", "md", "min-h-11")}>
                Next
              </button>
            ) : (
              <SaveButtons />
            )}
          </div>
        </section>

        {/* Step 3's side panel (W4, D5). Stacks under the form on a phone. */}
        <aside className={step === 3 ? "flex min-w-0 flex-col gap-4" : "hidden"}>
          <div className={`${CARD_CLASSES} p-5 text-sm`}>
            {!priceValid ? (
              <p className="text-muted">
                Enter a price in lek ({MINIMUM_PAID_CATALOG_PRICE_ALL} to{" "}
                {MAXIMUM_CATALOG_PRICE_ALL}) to see your estimated earnings.
              </p>
            ) : isFreeBook ? (
              <p className="font-medium text-foreground">
                Free book — no author earnings from sales.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-muted">Sale price</span>
                  <span>{formatAllMinorUnits(grossMinor)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <span className="text-muted">Librum platform fee ({PLATFORM_FEE_PERCENT}%)</span>
                  <span>-{formatAllMinorUnits(feeMinor)}</span>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                  <span className="font-medium text-foreground">You earn per sale</span>
                  <span className="font-serif text-2xl text-primary">
                    {formatAllMinorUnits(earningsMinor)}
                  </span>
                </div>
              </div>
            )}

            <Link href="/pricing" className={`${TEXT_LINK_CLASSES} mt-4 block`}>
              Not sure what to charge? See the earnings calculator &rarr;
            </Link>
          </div>

          {/* D5: the book as a reader's book card shows it -- cover (or
              the card's own no-cover fallback), title, byline (F4: the
              typed pen name, else the public author name) and
              formatCatalogPriceLabel(). No price line while the
              paid price is empty or invalid; no title line while the
              title is blank. */}
          <div className={`${CARD_CLASSES} flex gap-4 p-5`}>
            {cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={cover.previewUrl}
                alt=""
                className="h-[6.75rem] w-[4.5rem] shrink-0 rounded-[2px] object-cover shadow-[0_6px_14px_rgba(30,58,50,0.18)]"
              />
            ) : (
              <CoverPlaceholder
                title={title}
                authorName={byline}
                className="h-[6.75rem] w-[4.5rem] shrink-0 rounded-[2px] shadow-[0_6px_14px_rgba(30,58,50,0.18)]"
              />
            )}
            <div className="flex min-w-0 flex-col gap-1">
              <p className={BOX_LABEL_CLASSES}>How readers will see it</p>
              {title.trim() && (
                <p className="break-words font-serif text-lg leading-snug text-foreground">{title}</p>
              )}
              {byline && <p className="text-[0.8125rem] text-muted">{byline}</p>}
              {priceValid && (
                <p className={`text-sm font-bold ${isFreeBook ? "text-[#2f6b4f]" : "text-primary"}`}>
                  {formatCatalogPriceLabel(priceAll)}
                </p>
              )}
            </div>
          </div>
        </aside>
      </div>
    </form>
  );
}
