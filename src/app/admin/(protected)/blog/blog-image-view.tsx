"use client";

import { useState } from "react";
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react";
import { BlogImage } from "@/lib/blog-editor-markdown";
import { blogImageLayoutClass, normaliseBlogImageLayout, type BlogImagePos, type BlogImageSize } from "@/lib/blog-image-layout";
import { CropDialog } from "./blog-image-crop";
import { uploadBlogPicture } from "./blog-image-upload";

// A picture inside the one-box editor (Renato 2026-11-22). Clicking it
// shows the picture bar: Full / Half / Small (img1 a), Left / Centre /
// Right (img3 a, not for Full) and Crop (img2 a). The caption is typed
// straight under the picture.

const SIZES: { value: BlogImageSize; label: string }[] = [
  { value: "full", label: "Full" },
  { value: "half", label: "Half" },
  { value: "small", label: "Small" },
];
const POSITIONS: { value: BlogImagePos; label: string }[] = [
  { value: "left", label: "Left" },
  { value: "centre", label: "Centre" },
  { value: "right", label: "Right" },
];

const segClass = (on: boolean) =>
  `px-2.5 py-1 text-[13px] disabled:opacity-40 ${on ? "bg-primary text-primary-foreground" : "bg-surface text-foreground hover:bg-background"}`;

function BlogImageView({ node, updateAttributes, selected, extension }: ReactNodeViewProps) {
  const staffUserId = String(extension.options.staffUserId ?? "");
  const layout = normaliseBlogImageLayout({ size: node.attrs.size, pos: node.attrs.pos });
  const src = String(node.attrs.src ?? "");
  const caption = String(node.attrs.title ?? "");
  const [cropOpen, setCropOpen] = useState(false);

  async function onCropped(blob: Blob): Promise<string | void> {
    const result = await uploadBlogPicture(staffUserId, blob);
    if (!result.ok) return result.error;
    updateAttributes({ src: result.url });
    setCropOpen(false);
  }

  return (
    <NodeViewWrapper as="div" className={`relative ${blogImageLayoutClass(layout)}`} data-blog-image="">
      {selected && (
        <div
          contentEditable={false}
          role="toolbar"
          aria-label="Picture"
          className={`z-10 mb-2 flex w-max max-w-full flex-wrap items-center gap-1.5 rounded-card border border-border bg-surface p-1.5 shadow-md sm:absolute sm:bottom-full sm:max-w-none sm:flex-nowrap ${
            layout.size !== "full" && layout.pos === "right" ? "sm:right-0" : "sm:left-0"
          }`}
        >
          <span className="inline-flex overflow-hidden rounded-control border border-control" role="group" aria-label="Size">
            {SIZES.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={layout.size === s.value}
                onClick={() => updateAttributes(normaliseBlogImageLayout({ size: s.value, pos: layout.pos }))}
                className={segClass(layout.size === s.value)}
              >
                {s.label}
              </button>
            ))}
          </span>
          <span className="inline-flex overflow-hidden rounded-control border border-control" role="group" aria-label="Position">
            {POSITIONS.map((p) => (
              <button
                key={p.value}
                type="button"
                disabled={layout.size === "full"}
                title={layout.size === "full" ? "Full pictures are always centred" : undefined}
                aria-pressed={layout.size !== "full" && layout.pos === p.value}
                onClick={() => updateAttributes(normaliseBlogImageLayout({ size: layout.size, pos: p.value }))}
                className={segClass(layout.size !== "full" && layout.pos === p.value)}
              >
                {p.label}
              </button>
            ))}
          </span>
          <button
            type="button"
            onClick={() => setCropOpen(true)}
            className="rounded-control border border-control bg-surface px-2.5 py-1 text-[13px] hover:bg-background"
          >
            ✂ Crop
          </button>
        </div>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element -- an uploaded blog picture inside the editor. */}
      <img
        src={src}
        alt={caption}
        draggable={false}
        data-drag-handle=""
        className={`block h-auto w-full rounded-card ${selected ? "outline outline-[3px] outline-offset-2 outline-primary" : ""}`}
      />
      <input
        type="text"
        value={caption}
        maxLength={200}
        placeholder="Caption (optional)"
        aria-label="Caption, shown under the picture"
        onChange={(e) => updateAttributes({ title: e.target.value || null, alt: e.target.value })}
        className="mt-2 block w-full border-0 border-b border-dashed border-border bg-transparent p-0 text-sm text-muted placeholder:text-muted/70 focus:outline-none"
      />
      {cropOpen && <CropDialog source={src} onCropped={onCropped} onCancel={() => setCropOpen(false)} />}
    </NodeViewWrapper>
  );
}

export const EditorBlogImage = BlogImage.extend<{ staffUserId: string }>({
  addOptions() {
    return { ...this.parent?.(), staffUserId: "" } as ReturnType<NonNullable<typeof this.parent>> & { staffUserId: string };
  },
  draggable: true,
  addNodeView() {
    return ReactNodeViewRenderer(BlogImageView);
  },
});
