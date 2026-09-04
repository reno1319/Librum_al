"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { createBook } from "../actions";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { GENRES } from "@/lib/genres";
import { LANGUAGES, getLanguageLabel } from "@/lib/languages";
import { resolvePublishReadiness } from "@/lib/publish-readiness";
import {
  canAdvanceFromBookDetails,
  canAdvanceFromFiles,
  canAdvanceFromPrice,
  resolveWizardPriceSummary,
} from "./wizard-validation";
import { formControlClasses } from "@/lib/form-styles";
import { buttonClasses } from "@/components/ui/button";
import { ManuscriptField } from "@/components/manuscript-field";
import { CoverField } from "@/components/cover-field";
import type { Series } from "@/lib/types";

// LIBRUM 2.0 PUBLISHING-UX-1 PART C: redesigned step order and content --
// "Book Details" now comes FIRST (Title/Language/Genre, the fields the
// rest of the flow and EPUB metadata threading depend on), then
// "Cover & Manuscript", then "Price & Earnings", then a genuinely
// combined "Review & Publish" step that can end the flow either way
// (Save as draft OR Publish book) without leaving the page. Every field
// stays mounted across steps (display toggled, not unmounted) so
// uncontrolled/controlled values -- and CoverField/ManuscriptField's own
// upload state -- survive going back and forth, exactly as the
// pre-Part-C wizard already relied on.
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
const STEPS = ["Book Details", "Cover & Manuscript", "Price & Earnings", "Review & Publish"];

// Client-side-only bounds, purely a UX nicety mirroring actions.ts's own
// authoritative SUBTITLE_MAX_LENGTH/PUBLISHER_MAX_LENGTH/EDITION_MAX_LENGTH
// constants (not imported -- those are module-private to a "use server"
// file this task's own instructions protect from edits). A mismatch here
// has no security implication: the server re-validates and rejects an
// over-limit value independently, regardless of what a client sends.
const SUBTITLE_MAX_LENGTH = 300;
const PUBLISHER_MAX_LENGTH = 200;
const EDITION_MAX_LENGTH = 100;

function SaveButtons() {
  const { pending } = useFormStatus();
  return (
    <div className="flex flex-col items-end gap-2">
      {pending && (
        <p role="status" className="text-sm text-muted">
          Saving…
        </p>
      )}
      <div className="flex gap-3">
        <button
          type="submit"
          name="intent"
          value="draft"
          disabled={pending}
          className={buttonClasses("outline", "md", "disabled:cursor-not-allowed disabled:opacity-60")}
        >
          Save as draft
        </button>
        <button
          type="submit"
          name="intent"
          value="publish"
          disabled={pending}
          className={buttonClasses("primary", "md", "disabled:cursor-not-allowed disabled:opacity-60")}
        >
          Publish book
        </button>
      </div>
    </div>
  );
}

export function UploadWizard({
  series,
  authorName,
  authorId,
  payoutsEnabled,
}: {
  series: Series[];
  authorName: string;
  authorId: string;
  // LIBRUM 2.0 PUBLISHING-UX-1 PART C: display-only context for the
  // Review step's readiness section -- never a pre-submit gate. Publish
  // book can still be pressed even when this is false; performPublish()
  // (actions.ts) remains the one real, server-side enforcement point,
  // exactly as before this prop existed. See page.tsx for the one
  // narrow profile read that supplies it.
  payoutsEnabled: boolean;
}) {
  const [step, setStep] = useState(1);
  const [stepError, setStepError] = useState("");

  // LIBRUM 2.0 PRODUCT-5 COVER-1: no longer a File -- CoverField now
  // uploads directly to Storage and maintains its own small path
  // reference internally (see its own top-of-file comment), reporting
  // only display metadata here. PART C: now also carries previewUrl, so
  // Review can show an actual thumbnail without a second upload/preview
  // implementation.
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
  // so the Review step's readiness section can reuse
  // resolvePublishReadiness() with real live values instead of
  // reimplementing its logic.
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [price, setPrice] = useState("0");

  function goNext() {
    if (step === 1 && !canAdvanceFromBookDetails({ title, language, genre })) {
      setStepError("Add a title, language, and genre to continue.");
      return;
    }
    if (step === 2 && !canAdvanceFromFiles({ coverReady: !!cover, manuscriptReady: !!manuscript })) {
      setStepError("Add both a cover image and a manuscript file to continue.");
      return;
    }
    if (step === 3 && !canAdvanceFromPrice({ price })) {
      setStepError("Enter a valid price to continue.");
      return;
    }
    setStepError("");
    setStep((s) => Math.min(s + 1, STEPS.length));
  }

  function goBack() {
    setStepError("");
    setStep((s) => Math.max(s - 1, 1));
  }

  const { priceValid, isFreeBook, priceCents, feeCents, earningsCents } =
    resolveWizardPriceSummary(price);

  const readiness = resolvePublishReadiness({
    book: {
      description,
      keywords,
      price_cents: priceCents,
      cover_path: cover ? "pending" : null,
    },
    payoutsEnabled,
  });

  return (
    <form action={createBook} className="mt-6 flex flex-col gap-6">
      <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? "step" : undefined}
            className={step === i + 1 ? "font-semibold text-primary" : undefined}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {stepError && (
        <p role="status" className="rounded-lg border-l-4 border-red-600 bg-surface px-4 py-3 text-sm text-red-800">
          {stepError}
        </p>
      )}

      {/* Step 1: Book Details */}
      <div className={step === 1 ? "flex flex-col gap-4" : "hidden"}>
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input
            name="title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Language
          <select
            name="language"
            required
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            className={formControlClasses}
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
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Genre
          <select
            name="genre"
            required
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
            className={formControlClasses}
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
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Subtitle (optional)
          <input
            name="subtitle"
            type="text"
            maxLength={SUBTITLE_MAX_LENGTH}
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Description (optional)
          <textarea
            name="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className={formControlClasses}
          />
          <span className="text-xs text-muted">
            A couple of sentences or more helps readers decide.
          </span>
        </label>

        <details className="rounded-lg border border-border px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Additional book details
          </summary>
          <div className="mt-4 flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              ISBN (optional)
              <input
                name="isbn"
                type="text"
                placeholder="e.g. 978-3-16-148410-0"
                className={formControlClasses}
              />
              <span className="text-xs text-muted">
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
                className={formControlClasses}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Edition (optional)
              <input
                name="edition"
                type="text"
                placeholder="e.g. 2nd edition"
                maxLength={EDITION_MAX_LENGTH}
                className={formControlClasses}
              />
            </label>

            <label className="flex flex-col gap-1 text-sm">
              Originally published (optional)
              <input name="originalPublicationDate" type="date" className={formControlClasses} />
              <span className="text-xs text-muted">
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
                className={formControlClasses}
              />
              <span className="text-xs text-muted">
                Comma-separated. Helps readers find your book by terms beyond
                its genre — up to 15.
              </span>
            </label>

            {series.length === 0 && (
              <p className="text-xs text-muted">
                Want to group this with other books as a series?{" "}
                <Link href="/dashboard/series" className="focus-ring rounded-sm underline">
                  Create a series first
                </Link>
                , then come back here.
              </p>
            )}

            {series.length > 0 && (
              <div className="flex gap-3">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  Series (optional)
                  <select name="seriesId" defaultValue="" className={formControlClasses}>
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
                    className={`w-24 ${formControlClasses}`}
                  />
                </label>
              </div>
            )}
          </div>
        </details>
      </div>

      {/* Step 2: Cover & Manuscript */}
      <div className={step === 2 ? "flex flex-col gap-6" : "hidden"}>
        <div className="flex flex-col gap-4">
          <CoverField authorId={authorId} onCoverChange={setCover} />

          <ManuscriptField
            bookTitle={title}
            bookLanguage={language}
            authorName={authorName}
            authorId={authorId}
            onManuscriptChange={setManuscript}
          />

          <p role="status" className="text-xs text-muted">
            {[cover, manuscript].filter(Boolean).length} of 2 files ready.
          </p>

          <p className="text-xs text-muted">
            Readers can preview approximately the first 10% of your ebook —
            generated automatically, no extra steps needed.
          </p>
        </div>

        <aside className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted">
          <p className="font-medium text-foreground">Tips</p>
          <ul className="mt-1 flex flex-col gap-1 pl-4 list-disc">
            <li>Covers work best as a portrait image, at least 1000px tall.</li>
            <li>
              You can replace either file later from your dashboard before —
              or after — publishing.
            </li>
          </ul>
        </aside>
      </div>

      {/* Step 3: Price & Earnings */}
      <div className={step === 3 ? "flex flex-col gap-4" : "hidden"}>
        <label className="flex flex-col gap-1 text-sm">
          Price (USD)
          <input
            name="price"
            type="number"
            min="0"
            step="0.01"
            required
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            className={formControlClasses}
          />
          <span className="text-xs text-muted">
            Set to $0 for a free ebook. Librum takes a {PLATFORM_FEE_PERCENT}%
            platform fee — you keep the rest of every sale.
          </span>
        </label>

        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          {!priceValid ? (
            <p className="text-muted">Enter a valid price to see your estimated earnings.</p>
          ) : isFreeBook ? (
            <p className="font-medium text-foreground">
              Free book — no author earnings from sales.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Sale price</span>
                <span>${(priceCents / 100).toFixed(2)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Librum platform fee ({PLATFORM_FEE_PERCENT}%)</span>
                <span>-${(feeCents / 100).toFixed(2)}</span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2">
                <span className="font-medium text-foreground">You earn per sale</span>
                <span className="font-serif text-lg font-semibold text-primary">
                  ${(earningsCents / 100).toFixed(2)}
                </span>
              </div>
            </div>
          )}
        </div>

        <Link
          href="/pricing"
          className="focus-ring w-fit rounded-sm text-sm font-medium text-primary hover:underline"
        >
          Not sure what to charge? See the earnings calculator &rarr;
        </Link>
      </div>

      {/* Step 4: Review & Publish */}
      <div className={step === 4 ? "flex flex-col gap-4" : "hidden"}>
        <p className="text-sm text-muted">
          Double check the basics below, then save a draft or publish. Everything
          — including the cover and manuscript — can still be edited from your
          dashboard afterward.
        </p>

        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Book</p>
          <dl className="mt-2 grid gap-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Title</dt>
              <dd className="text-right">{title || "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Language</dt>
              <dd className="text-right">{language ? getLanguageLabel(language) : "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Genre</dt>
              <dd className="text-right">{genre || "—"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Files</p>
          <dl className="mt-2 grid gap-2">
            <div className="flex items-center justify-between gap-4">
              <dt className="text-muted">Cover</dt>
              <dd className="flex items-center gap-2 truncate text-right">
                {cover ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={cover.previewUrl}
                      alt=""
                      className="h-12 w-8 rounded object-cover"
                    />
                    <span className="truncate">{cover.name}</span>
                  </>
                ) : (
                  "—"
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted">Manuscript</dt>
              <dd className="truncate text-right">{manuscript?.name ?? "—"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Price</p>
          <p className="mt-2">
            {isFreeBook
              ? "Free"
              : priceValid
                ? `$${(priceCents / 100).toFixed(2)} · you earn $${(earningsCents / 100).toFixed(2)} per sale`
                : "—"}
          </p>
        </div>

        <div className="rounded-lg border border-border bg-surface p-4 text-sm">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Readiness</p>
          {readiness.payoutBlocked && (
            <p className="mt-2 text-red-800">
              Finish payout setup to publish paid books. Your book will still
              be saved as a draft either way.
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
          {!readiness.payoutBlocked && readiness.recommended.every((item) => item.done) && (
            <p className="mt-2 text-muted">Looks good — ready to publish.</p>
          )}
        </div>
      </div>

      <div className="flex justify-between gap-3">
        {step > 1 ? (
          <button
            type="button"
            onClick={goBack}
            className={buttonClasses("outline", "md")}
          >
            Back
          </button>
        ) : (
          <span />
        )}

        {step < STEPS.length ? (
          <button type="button" onClick={goNext} className={buttonClasses("primary", "md")}>
            Next
          </button>
        ) : (
          <SaveButtons />
        )}
      </div>
    </form>
  );
}
