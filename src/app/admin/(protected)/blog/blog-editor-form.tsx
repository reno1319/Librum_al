"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { resolveAutoSlug } from "@/lib/blog-slug";
import { calculateReadingTime } from "@/lib/blog-reading-time";
import { BlogCoverField } from "@/components/blog-cover-field";
import { Button } from "@/components/ui/button";
import { BlogContentEditor } from "./blog-content-editor";
import {
  CONTENT_MARKDOWN_MAX_LENGTH,
  EXCERPT_MAX_LENGTH,
  KEYWORD_MAX_LENGTH,
  KEYWORDS_MAX_COUNT,
  parseKeywords,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "./blog-form-logic";

export type BlogEditorInitialValues = {
  title: string;
  slug: string;
  excerpt: string;
  category: string;
  featured: boolean;
  isEditorial: boolean;
  keywords: string[];
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
  pinnedElsewhereTitle = null,
  categories,
}: {
  action: (formData: FormData) => void | Promise<void>;
  staffUserId: string;
  initialValues?: BlogEditorInitialValues;
  slugReadOnly: boolean;
  submitLabel: string;
  // e4: the title of the article pinned now, when it is not this one.
  pinnedElsewhereTitle?: string | null;
  // Patch B: the categories a post can be filed under, in their set
  // order (blog_categories, Editorial left out).
  categories: readonly { value: string; label: string }[];
}) {
  const [title, setTitle] = useState(initialValues?.title ?? "");
  const [slug, setSlug] = useState(initialValues?.slug ?? "");
  const [slugTouched, setSlugTouched] = useState(!!initialValues?.slug);
  const [excerpt, setExcerpt] = useState(initialValues?.excerpt ?? "");
  const [contentMarkdown, setContentMarkdown] = useState(initialValues?.contentMarkdown ?? "");
  const [keywords, setKeywords] = useState((initialValues?.keywords ?? []).join(", "));
  const keywordCount = parseKeywords(keywords).length;
  const [seoTitle, setSeoTitle] = useState(initialValues?.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(initialValues?.seoDescription ?? "");
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
    <form
      ref={formRef}
      action={action}
      className="mt-6 flex flex-col gap-6 lg:[&>*:not([data-wide])]:max-w-3xl"
    >
      <label className="flex flex-col gap-1 text-sm">
        Title
        <input
          type="text"
          name="title"
          required
          maxLength={TITLE_MAX_LENGTH}
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          className="rounded-control border border-control bg-surface px-3 py-2"
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
          className={`rounded-control border border-control px-3 py-2 font-mono text-sm ${
            slugReadOnly ? "bg-surface-hover text-muted" : "bg-surface"
          }`}
        />
        <span className="text-sm text-muted">
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
          defaultValue={initialValues?.category ?? ""}
          className="rounded-control border border-control bg-surface px-3 py-2"
        >
          {/* A new article starts on this blank choice (audit F2);
              `required` blocks the save in the browser and the server
              rejects "" too (validateBlogPostFields -> isBlogCategory).
              bs1: only real categories; Editorial is the tick
              below, on top of one of them. */}
          <option value="" disabled>
            Zgjidhni kategorinë
          </option>
          {categories.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="isEditorial"
          defaultChecked={initialValues?.isEditorial ?? false}
          className="mt-1"
        />
        <span>
          Editorial
          <span className="block text-muted">
            Adds the yellow &ldquo;Nga Librum&rdquo; tag and byline. The article shows in the
            Editorial section and in its category above.
          </span>
        </span>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Keywords
        <input
          type="text"
          name="keywords"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          placeholder="vetë-botim, e-libër, çmimi"
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
        <span className="text-sm text-muted">
          Separate with commas. Hidden from readers; only the blog search uses them. At least 1
          to publish, up to {KEYWORDS_MAX_COUNT}, each up to {KEYWORD_MAX_LENGTH} characters.
          {" · "}
          {keywordCount}/{KEYWORDS_MAX_COUNT}
        </span>
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
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
        <span className="text-sm text-muted">
          {excerpt.length}/{EXCERPT_MAX_LENGTH}
        </span>
      </label>

      <BlogCoverField staffUserId={staffUserId} existingCoverUrl={initialValues?.coverImageUrl ?? undefined} />

      <div data-wide className="flex flex-col gap-1">
        <BlogContentEditor staffUserId={staffUserId} contentMarkdown={contentMarkdown} onChange={setContentMarkdown} />
        <span className="text-sm text-muted">
          {contentMarkdown.length.toLocaleString()}/{CONTENT_MARKDOWN_MAX_LENGTH.toLocaleString()} characters
          {" · "}
          ~{readingMinutes} min read
        </span>
      </div>

      <div className="flex flex-col gap-0.5 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" name="featured" defaultChecked={initialValues?.featured ?? false} />
          📌 Pin to the top of the blog
        </label>
        <span className="pl-6 text-muted">
          {initialValues?.featured
            ? "Pinned now. Only one article can be pinned; pinning another one moves the pin."
            : pinnedElsewhereTitle
              ? `Only one article can be pinned. Ticking this moves the pin from «${pinnedElsewhereTitle}».`
              : "Only one article can be pinned. It shows at the top of the blog once it is live."}
        </span>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        SEO title (optional)
        <input
          type="text"
          name="seoTitle"
          maxLength={SEO_TITLE_MAX_LENGTH}
          value={seoTitle}
          onChange={(e) => setSeoTitle(e.target.value)}
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
        <span className="text-sm text-muted">
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
          className="rounded-control border border-control bg-surface px-3 py-2"
        />
        <span className="text-sm text-muted">
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
