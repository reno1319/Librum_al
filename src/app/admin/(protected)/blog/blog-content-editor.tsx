"use client";

import { forwardRef, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { plainFileInputClasses } from "@/lib/form-styles";
import { BlogMarkdown } from "@/components/blog-markdown";
import { applyFormat, insertImage, type FormatKind, type TextEdit } from "@/lib/markdown-format";
import { CONTENT_MARKDOWN_MAX_LENGTH } from "./blog-form-logic";
import { uploadBlogInlineImageAction } from "./actions";

// Blog editor (Renato 2026-11-19, pictures approved 12:31 UTC):
//   e1  buttons above the Markdown box; on a computer the finished look
//       shows live on the right, on a phone "Write | Preview" switches.
//   e2  the Image button uploads a picture to Librum (JPG, PNG or WebP,
//       up to 5 MB) with an optional caption.
// The textarea is always mounted, so the body is always in the form
// (QA H4); in Preview on a phone it is only hidden, and not `required`
// then, because a browser blocks a submit on a hidden invalid field
// with no message.

const TOOLS: { kind: FormatKind; label: string; title: string }[] = [
  { kind: "bold", label: "B", title: "Bold" },
  { kind: "italic", label: "I", title: "Italic" },
  { kind: "h2", label: "H2", title: "Heading" },
  { kind: "h3", label: "H3", title: "Small heading" },
  { kind: "ul", label: "• List", title: "Bulleted list" },
  { kind: "ol", label: "1. List", title: "Numbered list" },
  { kind: "quote", label: "❝ Quote", title: "Quote" },
  { kind: "link", label: "🔗 Link", title: "Link" },
];

const toolClass =
  "focus-ring inline-flex h-8 min-w-9 items-center justify-center rounded-control border border-control bg-surface px-2.5 text-sm text-foreground hover:bg-background";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export function BlogContentEditor({
  staffUserId,
  contentMarkdown,
  onChange,
}: {
  staffUserId: string;
  contentMarkdown: string;
  onChange: (value: string) => void;
}) {
  const [showPreview, setShowPreview] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  function apply(edit: TextEdit) {
    onChange(edit.text);
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(edit.selectionStart, edit.selectionEnd);
    });
  }

  function format(kind: FormatKind) {
    const ta = textareaRef.current;
    setShowPreview(false);
    apply(applyFormat(contentMarkdown, ta?.selectionStart ?? contentMarkdown.length, ta?.selectionEnd ?? contentMarkdown.length, kind));
  }

  function onImageInserted(url: string, caption: string) {
    const ta = textareaRef.current;
    setImageOpen(false);
    setShowPreview(false);
    apply(insertImage(contentMarkdown, ta?.selectionEnd ?? contentMarkdown.length, url, caption));
  }

  return (
    <div data-wide className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span>Content</span>
        <span className="hidden text-muted lg:inline">Live preview on the right</span>
        <span className="inline-flex overflow-hidden rounded-full border border-control lg:hidden" role="group" aria-label="Write or preview">
          <button
            type="button"
            aria-pressed={!showPreview}
            onClick={() => setShowPreview(false)}
            className={`px-3.5 py-1 ${showPreview ? "" : "bg-primary text-primary-foreground"}`}
          >
            Write
          </button>
          <button
            type="button"
            aria-pressed={showPreview}
            onClick={() => setShowPreview(true)}
            className={`px-3.5 py-1 ${showPreview ? "bg-primary text-primary-foreground" : ""}`}
          >
            Preview
          </button>
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Formatting">
        {TOOLS.map((t) => (
          <button key={t.kind} type="button" title={t.title} aria-label={t.title} onClick={() => format(t.kind)} className={toolClass}>
            {t.kind === "bold" ? <b>B</b> : t.kind === "italic" ? <i>I</i> : t.label}
          </button>
        ))}
        <button
          type="button"
          title="Image"
          aria-expanded={imageOpen}
          onClick={() => setImageOpen((v) => !v)}
          className={`${toolClass} ${imageOpen ? "border-primary ring-1 ring-primary" : ""}`}
        >
          🖼 Image
        </button>
      </div>

      {imageOpen && (
        <InlineImagePanel staffUserId={staffUserId} onInserted={onImageInserted} onCancel={() => setImageOpen(false)} />
      )}

      <ContentMarkdownInput
        ref={textareaRef}
        showPreview={showPreview}
        contentMarkdown={contentMarkdown}
        onChange={onChange}
      />
    </div>
  );
}

export const ContentMarkdownInput = forwardRef<
  HTMLTextAreaElement,
  { showPreview: boolean; contentMarkdown: string; onChange: (value: string) => void }
>(function ContentMarkdownInput({ showPreview, contentMarkdown, onChange }, ref) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <textarea
        ref={ref}
        name="contentMarkdown"
        required={!showPreview}
        rows={22}
        maxLength={CONTENT_MARKDOWN_MAX_LENGTH}
        value={contentMarkdown}
        onChange={(e) => onChange(e.target.value)}
        className={`${showPreview ? "hidden lg:block" : "block"} w-full min-w-0 rounded-control border border-control bg-surface px-3 py-2 font-mono text-sm`}
      />
      <div
        aria-label="Preview"
        className={`${showPreview ? "block" : "hidden lg:block"} min-w-0 overflow-y-auto rounded-card border border-border bg-surface px-4 py-3 lg:max-h-[40rem]`}
      >
        <BlogMarkdown markdown={contentMarkdown} />
      </div>
    </div>
  );
});

type PanelStatus = "idle" | "working" | "error";

function InlineImagePanel({
  staffUserId,
  onInserted,
  onCancel,
}: {
  staffUserId: string;
  onInserted: (url: string, caption: string) => void;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [error, setError] = useState("");

  function pick(next: File | null) {
    setError("");
    setStatus("idle");
    if (next && !IMAGE_TYPES.includes(next.type)) {
      setFile(null);
      setStatus("error");
      setError("Please choose a JPG, PNG or WebP image.");
      return;
    }
    if (next && next.size > MAX_IMAGE_BYTES) {
      setFile(null);
      setStatus("error");
      setError("Images must be under 5 MB.");
      return;
    }
    setFile(next);
  }

  async function insert() {
    if (!file) return;
    setStatus("working");
    setError("");
    try {
      // The private staging area only takes JPG and PNG, so a WebP is
      // turned into a JPEG here first (the server shrinks every image to
      // a JPEG anyway).
      const upload = file.type === "image/webp" ? await webpToJpeg(file) : file;
      if (!upload) throw new Error("webp conversion failed");
      const extension = upload.type === "image/png" ? "png" : "jpg";
      const tempPath = `${staffUserId}/tmp/blog/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await createClient()
        .storage.from("manuscripts")
        .upload(tempPath, upload, { contentType: upload.type });
      if (uploadError) throw uploadError;
      const result = await uploadBlogInlineImageAction(tempPath);
      if (!result.ok) {
        setStatus("error");
        setError(result.error);
        return;
      }
      onInserted(result.url, caption);
    } catch (err) {
      console.error("InlineImagePanel: upload failed:", err);
      setStatus("error");
      setError("We couldn't add this image. Please try again.");
    }
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-border bg-surface p-3.5 text-sm lg:max-w-3xl">
      <strong className="text-base font-semibold">Add an image</strong>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-label="Image file"
        onChange={(e) => pick(e.target.files?.[0] ?? null)}
        className={plainFileInputClasses}
      />
      <span className="text-muted">JPG, PNG or WebP · up to 5 MB. The image is uploaded to Librum.</span>
      <label className="flex flex-col gap-1">
        Caption (optional, shown under the image)
        <input
          type="text"
          value={caption}
          maxLength={200}
          onChange={(e) => setCaption(e.target.value)}
          className="rounded-control border border-control bg-background px-3 py-2"
        />
      </label>
      {status === "error" && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!file || status === "working"}
          onClick={insert}
          className="focus-ring inline-flex h-9 items-center rounded-full bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50"
        >
          {status === "working" ? "Uploading…" : "Insert image"}
        </button>
        <button type="button" onClick={onCancel} className="focus-ring inline-flex h-9 items-center rounded-full border border-control px-4">
          Cancel
        </button>
      </div>
    </div>
  );
}

async function webpToJpeg(file: File): Promise<File | null> {
  const bitmap = await createImageBitmap(file);
  // Never wider than 2400 px, so the JPEG stays well under the limit
  // (the server shrinks it to 1400 px anyway).
  const scale = Math.min(1, 2400 / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  return blob ? new File([blob], "image.jpg", { type: "image/jpeg" }) : null;
}
