"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { createBook } from "../actions";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { GENRES } from "@/lib/genres";
import type { Series } from "@/lib/types";

const STEPS = ["Manuscript & cover", "Details", "Price", "Review"];

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save as draft"}
    </button>
  );
}

export function UploadWizard({ series }: { series: Series[] }) {
  const [step, setStep] = useState(1);
  const [stepError, setStepError] = useState("");

  const [cover, setCover] = useState<File | null>(null);
  const [manuscript, setManuscript] = useState<File | null>(null);
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
    <form
      action={createBook}
      className="mt-6"
      style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}
    >
      <ol
        className="flex flex-wrap text-xs font-medium text-muted"
        style={{ gap: "0.5rem 1rem" }}
      >
        {STEPS.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? "step" : undefined}
            style={{
              color: step === i + 1 ? "var(--color-primary)" : undefined,
              fontWeight: step === i + 1 ? 700 : undefined,
            }}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      {stepError && (
        <p
          role="status"
          className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {stepError}
        </p>
      )}

      {/* Step 1: Manuscript & cover — every field below stays mounted across
          steps (just hidden via display) so uncontrolled inputs keep their
          value when you go back and forth between steps. */}
      <div
        style={{
          display: step === 1 ? "flex" : "none",
          flexDirection: "column",
          gap: "1.5rem",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
          <label className="flex flex-col gap-1 text-sm">
            Cover image (JPG or PNG, up to 5MB)
            <input
              name="cover"
              type="file"
              accept="image/png,image/jpeg"
              required
              className="text-sm"
              onChange={(e) => setCover(e.target.files?.[0] ?? null)}
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            Manuscript (EPUB file, up to 50MB)
            <input
              name="manuscript"
              type="file"
              accept=".epub,application/epub+zip"
              required
              className="text-sm"
              onChange={(e) => setManuscript(e.target.files?.[0] ?? null)}
            />
          </label>
        </div>

        <aside className="rounded-lg border border-dashed border-border px-4 py-3 text-xs text-muted">
          <p className="font-medium text-foreground">Tips</p>
          <ul className="mt-1 list-disc pl-4" style={{ display: "grid", gap: "0.25rem" }}>
            <li>Librum currently accepts EPUB manuscripts only.</li>
            <li>Covers work best as a portrait image, at least 1000px tall.</li>
            <li>
              You can replace either file later from your dashboard before —
              or after — publishing.
            </li>
          </ul>
        </aside>
      </div>

      {/* Step 2: Details */}
      <div
        style={{
          display: step === 2 ? "flex" : "none",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Title
          <input
            name="title"
            type="text"
            required
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Description
          <textarea
            name="description"
            rows={4}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Preview excerpt (optional)
          <textarea
            name="previewText"
            rows={8}
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
          <span className="text-xs text-muted">
            Shown to readers under &quot;Look inside&quot; before they buy —
            the opening page or two works well. Leave blank to skip.
          </span>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Keywords (optional)
          <input
            name="keywords"
            type="text"
            placeholder="e.g. space opera, first contact, hard sci-fi"
            className="rounded-lg border border-border bg-surface px-3 py-2"
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
            className="rounded-lg border border-border bg-surface px-3 py-2"
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
            className="rounded-lg border border-border bg-surface px-3 py-2"
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
            <Link href="/dashboard/series" className="underline">
              Create a series first
            </Link>
            , then come back here.
          </p>
        )}

        {series.length > 0 && (
          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              Series (optional)
              <select
                name="seriesId"
                defaultValue=""
                className="rounded-lg border border-border bg-surface px-3 py-2"
              >
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
                className="w-24 rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
          </div>
        )}
      </div>

      {/* Step 3: Price */}
      <div
        style={{
          display: step === 3 ? "flex" : "none",
          flexDirection: "column",
          gap: "1rem",
        }}
      >
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
            className="rounded-lg border border-border bg-surface px-3 py-2"
          />
          <span className="text-xs text-muted">
            Librum takes a {PLATFORM_FEE_PERCENT}% platform fee — you keep the
            rest of every sale.
          </span>
        </label>
        <Link
          href="/pricing"
          className="text-sm font-medium text-primary hover:underline"
        >
          Not sure what to charge? See the earnings calculator &rarr;
        </Link>
      </div>

      {/* Step 4: Review */}
      <div
        style={{
          display: step === 4 ? "flex" : "none",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <p className="text-sm text-muted">
          Double check the basics below, then save. Everything — including
          the cover and manuscript — can still be edited from your dashboard
          before you publish.
        </p>
        <dl
          className="rounded-lg border border-border bg-surface p-4 text-sm"
          style={{ display: "grid", gap: "0.5rem" }}
        >
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
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
          >
            Back
          </button>
        ) : (
          <span />
        )}

        {step < STEPS.length ? (
          <button
            type="button"
            onClick={goNext}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Next
          </button>
        ) : (
          <SaveButton />
        )}
      </div>
    </form>
  );
}
