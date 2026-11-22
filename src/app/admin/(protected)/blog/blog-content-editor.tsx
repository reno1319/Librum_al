"use client";

import { useState } from "react";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import { Markdown } from "@tiptap/markdown";
import { plainFileInputClasses } from "@/lib/form-styles";
import { BLOG_MARKED_OPTIONS, blogEditorExtensions } from "@/lib/blog-editor-markdown";
import { EditorBlogImage } from "./blog-image-view";
import { CropDialog } from "./blog-image-crop";
import { uploadBlogPicture } from "./blog-image-upload";

// Blog editor, one box (Renato 2026-11-22, ed3 a; pictures approved
// 09:43 UTC): staff edit the article as it will look, in one place. The
// separate preview box is gone; the full-page "Preview" link stays (ed5 a).
// The buttons are the same as before. The article is still saved as
// Markdown (src/lib/blog-editor-markdown.ts), sent in the hidden
// "contentMarkdown" field. If staff change nothing, the saved text is
// sent back exactly as it was.
// Pictures: size, position, wrap and crop (img1-img3), see
// blog-image-view.tsx. The old box jumped to the bottom after Bold or
// Italic (item 1); this editor has no such box.

type Tool = { key: string; label: React.ReactNode; title: string; run: (e: Editor) => void; active: (e: Editor) => boolean };

const TOOLS: Tool[] = [
  { key: "bold", label: <b>B</b>, title: "Bold", run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive("bold") },
  { key: "italic", label: <i>I</i>, title: "Italic", run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive("italic") },
  { key: "h2", label: "H2", title: "Heading", run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive("heading", { level: 2 }) },
  { key: "h3", label: "H3", title: "Small heading", run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run(), active: (e) => e.isActive("heading", { level: 3 }) },
  { key: "ul", label: "• List", title: "Bulleted list", run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive("bulletList") },
  { key: "ol", label: "1. List", title: "Numbered list", run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive("orderedList") },
  { key: "quote", label: "❝ Quote", title: "Quote", run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive("blockquote") },
];

const toolClass =
  "focus-ring inline-flex h-8 min-w-9 items-center justify-center rounded-control border border-control bg-surface px-2.5 text-sm text-foreground hover:bg-background";
const toolOn = "border-primary ring-1 ring-primary";

// The same look as BlogMarkdown (the public article), applied to the
// editor's own HTML.
const CONTENT_CLASS = [
  "min-h-[26rem] px-4 py-3 text-foreground outline-none flow-root",
  "[&>*:first-child]:mt-0",
  "[&_h1]:mt-6 [&_h1]:font-serif [&_h1]:text-2xl [&_h1]:font-normal",
  "[&_h2]:mt-6 [&_h2]:font-serif [&_h2]:text-xl [&_h2]:font-normal",
  "[&_h3]:mt-4 [&_h3]:font-serif [&_h3]:text-lg [&_h3]:font-normal",
  "[&_p]:mt-4 [&_p]:leading-relaxed [&_p]:text-foreground/90",
  "[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2",
  "[&_ul]:mt-4 [&_ul]:flow-root [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-6",
  "[&_ol]:mt-4 [&_ol]:flow-root [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-6",
  "[&_li>p]:mt-0",
  "[&_blockquote]:mt-4 [&_blockquote]:flow-root [&_blockquote]:border-l-4 [&_blockquote]:border-primary [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-muted",
  "[&_hr]:my-8 [&_hr]:border-border [&_strong]:font-semibold",
].join(" ");

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
  const [panel, setPanel] = useState<"none" | "image" | "link">("none");

  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      ...blogEditorExtensions(EditorBlogImage.configure({ staffUserId })),
      Markdown.configure({ markedOptions: BLOG_MARKED_OPTIONS }),
    ],
    content: contentMarkdown,
    contentType: "markdown",
    editorProps: {
      attributes: { class: CONTENT_CLASS, "aria-label": "Content", "aria-multiline": "true", role: "textbox" },
    },
    onUpdate: ({ editor: e }) => onChange(e.getMarkdown()),
  });

  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? Object.fromEntries(TOOLS.map((t) => [t.key, t.active(e)]).concat([["link", e.isActive("link")]])) : {}),
  });

  function insertPicture(url: string, caption: string) {
    const clean = caption.replace(/\s+/g, " ").trim();
    editor
      ?.chain()
      .focus()
      .insertContent({ type: "image", attrs: { src: url, title: clean || null, alt: clean, size: "full", pos: "centre" } })
      .run();
    setPanel("none");
  }

  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm">Content</span>
      {/* The saved article, as Markdown. */}
      <input type="hidden" name="contentMarkdown" value={contentMarkdown} />

      <div className="flex flex-wrap gap-1.5" role="toolbar" aria-label="Formatting">
        {TOOLS.map((t) => (
          <button
            key={t.key}
            type="button"
            title={t.title}
            aria-label={t.title}
            aria-pressed={Boolean(active?.[t.key])}
            disabled={!editor}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editor && t.run(editor)}
            className={`${toolClass} ${active?.[t.key] ? toolOn : ""}`}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          title="Link"
          aria-expanded={panel === "link"}
          disabled={!editor}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPanel((p) => (p === "link" ? "none" : "link"))}
          className={`${toolClass} ${panel === "link" || active?.link ? toolOn : ""}`}
        >
          🔗 Link
        </button>
        <button
          type="button"
          title="Image"
          aria-expanded={panel === "image"}
          disabled={!editor}
          onClick={() => setPanel((p) => (p === "image" ? "none" : "image"))}
          className={`${toolClass} ${panel === "image" ? toolOn : ""}`}
        >
          🖼 Image
        </button>
      </div>

      {panel === "link" && editor && <LinkPanel editor={editor} onDone={() => setPanel("none")} />}
      {panel === "image" && (
        <InlineImagePanel staffUserId={staffUserId} onInserted={insertPicture} onCancel={() => setPanel("none")} />
      )}

      <div className="w-full min-w-0 rounded-control border border-control bg-surface focus-within:ring-2 focus-within:ring-primary/40">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// 🔗 Link: the address for the selected words. With nothing selected,
// the address itself is added as a link.
function LinkPanel({ editor, onDone }: { editor: Editor; onDone: () => void }) {
  const current = String(editor.getAttributes("link").href ?? "");
  const [href, setHref] = useState(current || "https://");
  const [error, setError] = useState("");

  function apply() {
    const value = href.trim();
    if (!/^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i.test(value) || value === "https://") {
      setError("Please enter a full address starting with https://");
      return;
    }
    const chain = editor.chain().focus();
    if (editor.state.selection.empty && !editor.isActive("link")) {
      chain.insertContent({ type: "text", text: value, marks: [{ type: "link", attrs: { href: value } }] }).run();
    } else {
      chain.extendMarkRange("link").setLink({ href: value }).run();
    }
    onDone();
  }

  return (
    <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-3.5 text-sm lg:max-w-3xl">
      <label className="flex flex-col gap-1">
        Link address
        <input
          type="url"
          value={href}
          autoFocus
          onChange={(e) => setHref(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          className="rounded-control border border-control bg-background px-3 py-2"
        />
      </label>
      {error && (
        <p role="alert" className="text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={apply} className="focus-ring inline-flex h-9 items-center rounded-full bg-primary px-4 font-medium text-primary-foreground">
          Apply link
        </button>
        {current && (
          <button
            type="button"
            onClick={() => {
              editor.chain().focus().extendMarkRange("link").unsetLink().run();
              onDone();
            }}
            className="focus-ring inline-flex h-9 items-center rounded-full border border-control px-4"
          >
            Remove link
          </button>
        )}
        <button type="button" onClick={onDone} className="focus-ring inline-flex h-9 items-center rounded-full border border-control px-4">
          Cancel
        </button>
      </div>
    </div>
  );
}

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
  const [file, setFile] = useState<Blob | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [cropOpen, setCropOpen] = useState(false);
  const [caption, setCaption] = useState("");
  const [status, setStatus] = useState<PanelStatus>("idle");
  const [error, setError] = useState("");

  function choose(next: Blob | null) {
    if (preview) URL.revokeObjectURL(preview);
    setFile(next);
    setPreview(next ? URL.createObjectURL(next) : null);
  }

  function pick(next: File | null) {
    setError("");
    setStatus("idle");
    if (next && !IMAGE_TYPES.includes(next.type)) {
      choose(null);
      setStatus("error");
      setError("Please choose a JPG, PNG or WebP image.");
      return;
    }
    if (next && next.size > MAX_IMAGE_BYTES) {
      choose(null);
      setStatus("error");
      setError("Images must be under 5 MB.");
      return;
    }
    choose(next);
  }

  async function insert() {
    if (!file) return;
    setStatus("working");
    setError("");
    try {
      const result = await uploadBlogPicture(staffUserId, file);
      if (!result.ok) {
        setStatus("error");
        setError(result.error);
        return;
      }
      if (preview) URL.revokeObjectURL(preview);
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
      {preview && (
        <div className="flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file. */}
          <img src={preview} alt="" className="h-16 w-auto rounded-control" />
          <button
            type="button"
            onClick={() => setCropOpen(true)}
            className="focus-ring inline-flex h-9 items-center rounded-full border border-control px-4"
          >
            ✂ Crop
          </button>
        </div>
      )}
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
      {cropOpen && preview && (
        <CropDialog
          source={preview}
          onCropped={(blob) => {
            choose(blob);
            setCropOpen(false);
          }}
          onCancel={() => setCropOpen(false)}
        />
      )}
    </div>
  );
}
