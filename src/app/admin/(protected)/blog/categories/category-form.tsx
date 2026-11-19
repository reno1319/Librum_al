"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { suggestCategoryAddress } from "@/lib/blog-categories";
import {
  BLOG_CATEGORY_COLOURS,
  BLOG_CATEGORY_PICKABLE_COLOURS,
  type BlogCategoryColour,
} from "@/lib/blog-category-colours";

export type CategoryFormValues = {
  label: string;
  shortLabel: string;
  description: string;
  urlSlug: string;
  colour: BlogCategoryColour;
  cta: "publish" | "browse";
};

const INPUT = "rounded-control border border-control bg-surface px-3 py-2";

export function CategoryForm({
  mode,
  initial,
  submitLabel,
  action,
}: {
  // "new": every field. "edit": address fixed. "editorial": name,
  // short name and description only (b2 b).
  mode: "new" | "edit" | "editorial";
  initial: CategoryFormValues;
  submitLabel: string;
  action: (formData: FormData) => void | Promise<void>;
}) {
  const [label, setLabel] = useState(initial.label);
  const [urlSlug, setUrlSlug] = useState(initial.urlSlug);
  const [slugTouched, setSlugTouched] = useState(mode !== "new");
  const [colour, setColour] = useState<BlogCategoryColour>(initial.colour);
  const pair = BLOG_CATEGORY_COLOURS[colour];

  return (
    <form action={action} className="mt-6 flex flex-col gap-5">
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          type="text"
          name="label"
          required
          maxLength={60}
          value={label}
          onChange={(e) => {
            setLabel(e.target.value);
            if (!slugTouched) setUrlSlug(suggestCategoryAddress(e.target.value));
          }}
          className={INPUT}
        />
        <span className="text-muted">Shown on the category page, its band on /blog and article labels.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Short name
        <input type="text" name="shortLabel" required maxLength={24} defaultValue={initial.shortLabel} className={INPUT} />
        <span className="text-muted">Shown on the category buttons under the search box. Up to 24 characters.</span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Description
        <textarea name="description" required maxLength={200} rows={2} defaultValue={initial.description} className={INPUT} />
        <span className="text-muted">One line under the name.</span>
      </label>

      {mode !== "editorial" && (
        <label className="flex flex-col gap-1 text-sm">
          Address
          <div className="flex items-stretch">
            <span className="flex items-center rounded-l-control border border-r-0 border-control bg-surface-hover px-3 font-mono text-xs text-muted">
              /blog/kategoria/
            </span>
            <input
              type="text"
              name="urlSlug"
              required
              readOnly={mode !== "new"}
              maxLength={60}
              value={urlSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setUrlSlug(e.target.value);
              }}
              className={`min-w-0 flex-1 rounded-r-control border border-control px-3 py-2 font-mono text-sm ${
                mode === "new" ? "bg-surface" : "bg-surface-hover text-muted"
              }`}
            />
          </div>
          <span className="text-muted">
            {mode === "new"
              ? "Filled in from the name. It can't be changed after you create the category."
              : "The address can't be changed, so old links keep working."}
          </span>
        </label>
      )}

      {mode !== "editorial" && (
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Colour</legend>
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
            {BLOG_CATEGORY_PICKABLE_COLOURS.map((c) => {
              const p = BLOG_CATEGORY_COLOURS[c];
              const on = c === colour;
              return (
                <label
                  key={c}
                  className={`flex cursor-pointer flex-col items-center gap-1 rounded-card border-2 p-2 ${
                    on ? "border-foreground" : "border-transparent"
                  }`}
                  style={{ backgroundColor: p.tint }}
                >
                  <input
                    type="radio"
                    name="colour"
                    value={c}
                    checked={on}
                    onChange={() => setColour(c)}
                    className="sr-only"
                  />
                  <span className="font-serif text-xl" style={{ color: p.ink }} aria-hidden="true">
                    Aa
                  </span>
                  <span className="text-xs" style={{ color: p.ink }}>
                    {p.name}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="mt-1 rounded-card px-4 py-3" style={{ backgroundColor: pair.tint }}>
            <p className="text-xs text-muted">Preview</p>
            <p className="font-serif text-2xl" style={{ color: pair.ink }}>
              {label || "Category name"}
            </p>
          </div>
          <span className="text-muted">Colours can repeat once there are more than 8 categories.</span>
        </fieldset>
      )}

      {mode !== "editorial" && (
        <fieldset className="flex flex-col gap-2 text-sm">
          <legend className="mb-1">Button at the bottom of the category page</legend>
          <label className="flex items-start gap-2">
            <input type="radio" name="cta" value="publish" defaultChecked={initial.cta === "publish"} className="mt-1" />
            <span>
              For authors: &ldquo;Gati ta botoni librin tuaj?&rdquo; &middot; <b>Publikoni librin tuaj</b>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="cta" value="browse" defaultChecked={initial.cta === "browse"} className="mt-1" />
            <span>
              For readers: &ldquo;Po kërkoni librin tuaj të radhës?&rdquo; &middot; <b>Shfletoni librarinë</b>
            </span>
          </label>
        </fieldset>
      )}

      <div>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
