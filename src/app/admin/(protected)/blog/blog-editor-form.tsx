"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { BLOG_CATEGORIES } from "@/lib/blog-categories";
import type { BlogCategory } from "@/lib/types";
import { resolveAutoSlug } from "@/lib/blog-slug";
import { calculateReadingTime } from "@/lib/blog-reading-time";
import { BlogCoverField } from "@/components/blog-cover-field";
import { BlogMarkdown } from "@/components/blog-markdown";
import { Button } from "@/components/ui/button";
import {
  CONTENT_MARKDOWN_MAX_LENGTH,
  EXCERPT_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./blog-form-logic";

export type BlogEditorInitialValues = {
  title: string;
  slug: string;
  excerpt: string;
  category: BlogCategory;
  featured: boolean;
  seoTitle: string;
  seoDescription: string;
  contentMarkdown: string;
  coverImageUrl: string | null;
};

// LIBRUM 2.0 BLOG-1C: the one shared form for both /admin/blog/new and
// /admin/blog/[id]/edit -- status/published_at/created_by are never
// rendered as controls anywhere in this component (per the brief's own
// "do not expose status/published_at/created_by controls" instruction);
// those fields only ever change through publish/unpublish/delete, each
// its own explicit action on the edit page, never through this form's
// own submit.
//
// Slug auto-generation: only while the slug field has never been
// manually touched by the user -- once touched, title edits never
// overwrite it again (per the brief's own "do not constantly overwrite
// it" instruction). slugReadOnly (published posts) disables this
// entirely and renders the slug as `readOnly`, not `disabled` -- a
// disabled input's value is never included in FormData at all, and the
// server action still needs to receive the (unchanged) slug value on
// every save.
export function BlogEditorForm({
  action,
  staffUserId,
  initialValues,
  slugReadOnly,
  submitLabel,
}: {
  action: (formData: FormData) => void | Promise<void>;
  staffUserId: string;
  initialValues?: BlogEditorInitialValues;
  slugReadOnly: boolean;
  submitLabel: string;
}) {
  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [slug, setSlug] = useState(initialValues?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!initialValues?.slug);
  const [excerpt, setExcerpt] = useState(initialValues?.excerpt ?? "");
  const [contentMarkdown, setContentMarkdown] = useState(initialValues?.contentMarkdown ?? "");
  const [seoTitle, setSeoTitle] = useState(initialValues?.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(initialValues?.seoDescription ?? "");
  const [showPreview, setShowPreview] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  function handleTitleChange(value: string) {
    setTitle(value);
    setSlug((currentSlug) =>
      resolveAutoSlug({ currentSlug, title: value, slugTouched, slugReadOnly }),
    );
  }

  function handleSlugChange(value: string) {
    setSlugTouched(true);
    setSlug(value);
  }

  const readingMinutes = calculateReadingTime(contentMarkdown);

  return (
    <form ref={formRef} action={action} className="mt-6 flex flex-col gap-6">
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          type="text"
          name="title"
          required
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2"
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Slug
        <input
          type="text"
          name="slug"
          required
          readOnly={slugReadOnly}
          maxLength={SLUG_MAX_LENGTH}
          value={slug}
          onChange={(e) => handleSlugChange(e.target.value)}
          className={`rounded-lg border border-border px-3 py-2 font-mono text-sm ${
            slugReadOnly ? "bg-surface-hover text-muted" : "bg-surface"
          }`}
        />
        <span className="text-xs text-muted">
          {slugReadOnly
            ? "The URL slug can't be changed once an article is published."
            : "Auto-filled from the title. Edit it directly if you need a different URL."}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Category
        <select
          name="category"
          required
          defaultValue={initialValues?.category ?? BLOG_CATEGORIES[0].value}
          className="rounded-lg border border-border bg-surface px-3 py-2"
        >
          {BLOG_CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Excerpt
        <textarea
          name="excerpt"
          required
          rows={3}
          maxLength={EXCERPT_MAX_LENGTH}
          value={excerpt}
          onChange={(e) => setExcerpt(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2"
        />
        <span className="text-xs text-muted">
          {excerpt.length}/{EXCERPT_MAX_LENGTH}
        </span>
      </label>

      <BlogCoverField staffUserId={staffUserId} existingCoverUrl={initialValues?.coverImageUrl ?? undefined} />

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-sm">
          <span>Content (Markdown)</span>
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="text-primary hover:underline"
          >
            {showPreview ? "Back to editing" : "Preview"}
          </button>
        </div>

        {showPreview ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-3">
            <BlogMarkdown markdown={contentMarkdown} />
          </div>
        ) : (
          <textarea
            name="contentMarkdown"
            required
            rows={16}
            maxLength={CONTENT_MARKDOWN_MAX_LENGTH}
            value={contentMarkdown}
            onChange={(e) => setContentMarkdown(e.target.value)}
            className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm"
          />
        )}
        <span className="text-xs text-muted">
          {contentMarkdown.length.toLocaleString()}/{CONTENT_MARKDOWN_MAX_LENGTH.toLocaleString()} characters
          {" · "}
          ~{readingMinutes} min read
        </span>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="featured" defaultChecked={initialValues?.featured ?? false} />
        Featured article
      </label>

      <label className="flex flex-col gap-1 text-sm">
        SEO title (optional)
        <input
          type="text"
          name="seoTitle"
          maxLength={SEO_TITLE_MAX_LENGTH}
          value={seoTitle}
          onChange={(e) => setSeoTitle(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2"
        />
        <span className="text-xs text-muted">
          {seoTitle.length}/{SEO_TITLE_MAX_LENGTH}
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        SEO description (optional)
        <textarea
          name="seoDescription"
          rows={2}
          maxLength={SEO_DESCRIPTION_MAX_LENGTH}
          value={seoDescription}
          onChange={(e) => setSeoDescription(e.target.value)}
          className="rounded-lg border border-border bg-surface px-3 py-2"
        />
        <span className="text-xs text-muted">
          {seoDescription.length}/{SEO_DESCRIPTION_MAX_LENGTH}
        </span>
      </label>

      <SubmitButton label={submitLabel} />
    </form>
  );
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} className="self-start">
      {label}
    </Button>
  );
}
