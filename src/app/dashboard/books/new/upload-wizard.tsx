"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { createBook } from "../actions";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { GENRES } from "@/lib/genres";
import { formControlClasses } from "@/lib/form-styles";
import { buttonClasses } from "@/components/ui/button";
import { ManuscriptField } from "@/components/manuscript-field";
import { CoverField } from "@/components/cover-field";
import type { Series } from "@/lib/types";

// LIBRUM 2.0 UI-7: four steps -- Files, Book Details, Pricing, Review --
// unchanged in count/order from the pre-UI-7 wizard (the audit found
// this grouping was already sound); this pass refines labels, adds a
// cover preview, and applies focus-ring/shared form-control styling.
// Every field stays mounted across steps (display toggled, not
// unmounted) so uncontrolled/controlled values survive going back and
// forth -- exactly as before. This is genuinely one atomic submission:
// nothing is saved to the server until "Save as draft" on the final
// step, which is why that step is never called "Publish" -- createBook()
// always creates status="draft" regardless of how complete the form is.
const STEPS = ["Files", "Book Details", "Pricing", "Review"];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={buttonClasses("primary", "md", "disabled:cursor-not-allowed disabled:opacity-60")}
    >
      {pending ? "Saving…" : "Save as draft"}
    </button>
  );
}

export function UploadWizard({
  series,
  authorName,
  authorId,
}: {
  series: Series[];
  authorName: string;
  authorId: string;
}) {
  const [step, setStep] = useState(1);
  const [stepError, setStepError] = useState("");

  // LIBRUM 2.0 PRODUCT-5 COVER-1: no longer a File -- CoverField now
  // uploads directly to Storage and maintains its own small path
  // reference internally (see its own top-of-file comment), reporting
  // only display metadata here, just enough for this wizard's own
  // step-readiness check and Review-step summary below. Its local
  // preview (Object URL) is now entirely CoverField's own concern too.
  const [cover, setCover] = useState<{ name: string } | null>(null);
  // LIBRUM 2.0 PRODUCT-5 CB-1: no longer a File -- ManuscriptField now
  // maintains a small Storage-path reference internally (see its own
  // top-of-file comment) and reports only display metadata here, just
  // enough for this wizard's own step-readiness check and Review-step
  // summary below.
  const [manuscript, setManuscript] = useState<{ name: string } | null>(null);
  const [title, setTitle] = useState("");
  const [genre, setGenre] = useState("");
  const [price, setPrice] = useState("0");

  function goNext() {
    if (step === 1 && (!cover || !manuscript)) {
      setStepError("Add both a cover image and a manuscript file to continue.");
      return;
    }
    if (step === 2 && (!title.trim() || !genre)) {
      setStepError("Add a title and choose a genre to continue.");
      return;
    }
    if (step === 3) {
      const priceValue = Number(price);
      if (!Number.isFinite(priceValue) || priceValue < 0) {
        setStepError("Enter a valid price to continue.");
        return;
      }
    }
    setStepError("");
    setStep((s) => Math.min(s + 1, STEPS.length));
  }

  function goBack() {
    setStepError("");
    setStep((s) => Math.max(s - 1, 1));
  }

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

      {/* Step 1: Files */}
      <div className={step === 1 ? "flex flex-col gap-6" : "hidden"}>
        <div className="flex flex-col gap-4">
          <CoverField authorId={authorId} onCoverChange={setCover} />

          <ManuscriptField
            bookTitle={title}
            authorName={authorName}
            authorId={authorId}
            onManuscriptChange={setManuscript}
          />
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

      {/* Step 2: Book Details */}
      <div className={step === 2 ? "flex flex-col gap-4" : "hidden"}>
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
          Description (optional)
          <textarea name="description" rows={4} className={formControlClasses} />
          <span className="text-xs text-muted">
            A couple of sentences or more helps readers decide.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Keywords (optional)
          <input
            name="keywords"
            type="text"
            placeholder="e.g. space opera, first contact, hard sci-fi"
            className={formControlClasses}
          />
          <span className="text-xs text-muted">
            Comma-separated. Helps readers find your book by terms beyond its
            genre — up to 15.
          </span>
        </label>

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

      {/* Step 3: Pricing */}
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
        <Link
          href="/pricing"
          className="focus-ring w-fit rounded-sm text-sm font-medium text-primary hover:underline"
        >
          Not sure what to charge? See the earnings calculator &rarr;
        </Link>
      </div>

      {/* Step 4: Review -- a review of what will be saved as a draft, not
          of what will be published (those are different moments; see
          SaveButton above). */}
      <div className={step === 4 ? "flex flex-col gap-3" : "hidden"}>
        <p className="text-sm text-muted">
          Double check the basics below, then save. Everything — including
          the cover and manuscript — can still be edited from your dashboard
          before you publish.
        </p>
        <dl className="grid gap-2 rounded-lg border border-border bg-surface p-4 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Title</dt>
            <dd className="text-right">{title || "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Genre</dt>
            <dd className="text-right">{genre || "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Price</dt>
            <dd className="text-right">
              {Number.isFinite(Number(price)) && Number(price) === 0
                ? "Free"
                : `$${Number.isFinite(Number(price)) ? Number(price).toFixed(2) : "0.00"}`}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Cover</dt>
            <dd className="truncate text-right">{cover?.name ?? "—"}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Manuscript</dt>
            <dd className="truncate text-right">{manuscript?.name ?? "—"}</dd>
          </div>
        </dl>
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
          <SaveButton />
        )}
      </div>
    </form>
  );
}
