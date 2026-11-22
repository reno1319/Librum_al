"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CROP_SHAPES,
  initialCropFrame,
  moveCropFrame,
  outputSize,
  toSourceRect,
  type CropShape,
  type Rect,
} from "@/lib/image-crop";

// img2 a (Renato 2026-11-22): "Crop picture" — pick a shape, then drag
// the frame to choose which part to keep. Used before a new picture is
// uploaded and on a picture already in the article. The cropped copy is
// a new JPEG; the caller uploads it.

const pillClass = "focus-ring inline-flex h-9 items-center rounded-full px-3.5 text-sm";

export function CropDialog({
  source,
  onCropped,
  onCancel,
}: {
  source: string;
  // Returns an error to show (e.g. the upload failed), or nothing.
  onCropped: (blob: Blob) => Promise<string | void> | string | void;
  onCancel: () => void;
}) {
  const imgRef = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [shape, setShape] = useState<CropShape>("original");
  const [shown, setShown] = useState<{ width: number; height: number } | null>(null);
  const [frame, setFrame] = useState<Rect | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "working" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  function measure() {
    const img = imgRef.current;
    if (!img) return;
    const size = { width: img.clientWidth, height: img.clientHeight };
    setShown(size);
    setFrame(initialCropFrame(size.width, size.height, shape));
    setStatus("ready");
  }

  function pickShape(next: CropShape) {
    setShape(next);
    if (shown) setFrame(initialCropFrame(shown.width, shown.height, next));
  }

  function move(dx: number, dy: number) {
    if (!frame || !shown) return;
    setFrame(moveCropFrame(frame, dx, dy, shown.width, shown.height));
  }

  async function apply() {
    const img = imgRef.current;
    if (!img || !frame || !shown) return;
    // "Original" keeps the whole picture: nothing to crop.
    if (shape === "original") return onCancel();
    setStatus("working");
    setError("");
    try {
      const src = toSourceRect(frame, shown.width, img.naturalWidth, img.naturalHeight);
      const out = outputSize(src);
      const canvas = document.createElement("canvas");
      canvas.width = out.width;
      canvas.height = out.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no canvas");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);
      ctx.drawImage(img, src.x, src.y, src.width, src.height, 0, 0, out.width, out.height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
      if (!blob) throw new Error("no blob");
      const problem = await onCropped(blob);
      if (problem) {
        setStatus("error");
        setError(problem);
      }
    } catch (err) {
      console.error("CropDialog: crop failed:", err);
      setStatus("error");
      setError("We couldn't crop this picture. Please try again.");
    }
  }

  const dialog = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4" role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Crop picture"
        className="flex max-h-full w-full max-w-[600px] flex-col gap-3 overflow-y-auto rounded-card bg-surface p-5 text-sm text-foreground"
      >
        <h2 className="font-serif text-xl font-normal">Crop picture</h2>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Shape">
          {CROP_SHAPES.map((s) => (
            <button
              key={s.shape}
              type="button"
              aria-pressed={shape === s.shape}
              onClick={() => pickShape(s.shape)}
              className={`${pillClass} ${shape === s.shape ? "bg-primary text-primary-foreground" : "border border-control bg-background"}`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="relative self-start overflow-hidden rounded-control">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local file or an uploaded blog picture shown for cropping. */}
          <img
            ref={imgRef}
            src={source}
            alt=""
            crossOrigin="anonymous"
            onLoad={measure}
            onError={() => {
              setStatus("error");
              setError("We couldn't load this picture for cropping.");
            }}
            className="block max-h-[55vh] w-auto max-w-full select-none"
            draggable={false}
          />
          {frame && shown && (
            <>
              <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <div className="absolute bg-black/55" style={{ left: 0, top: 0, width: shown.width, height: frame.y }} />
                <div className="absolute bg-black/55" style={{ left: 0, top: frame.y + frame.height, width: shown.width, bottom: 0 }} />
                <div className="absolute bg-black/55" style={{ left: 0, top: frame.y, width: frame.x, height: frame.height }} />
                <div className="absolute bg-black/55" style={{ left: frame.x + frame.width, top: frame.y, right: 0, height: frame.height }} />
              </div>
              <div
                role="slider"
                tabIndex={0}
                aria-label="Part of the picture to keep. Use the arrow keys to move it."
                aria-valuemin={0}
                aria-valuemax={Math.round(Math.max(shown.width - frame.width, shown.height - frame.height))}
                aria-valuenow={Math.round(Math.max(frame.x, frame.y))}
                aria-valuetext={`${Math.round(frame.x)}, ${Math.round(frame.y)}`}
                className="focus-ring absolute cursor-move touch-none border-2 border-white"
                style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
                onPointerDown={(e) => {
                  drag.current = { x: e.clientX, y: e.clientY };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!drag.current) return;
                  move(e.clientX - drag.current.x, e.clientY - drag.current.y);
                  drag.current = { x: e.clientX, y: e.clientY };
                }}
                onPointerUp={() => (drag.current = null)}
                onPointerCancel={() => (drag.current = null)}
                onKeyDown={(e) => {
                  const step = e.shiftKey ? 40 : 10;
                  const moves: Record<string, [number, number]> = {
                    ArrowLeft: [-step, 0],
                    ArrowRight: [step, 0],
                    ArrowUp: [0, -step],
                    ArrowDown: [0, step],
                  };
                  const m = moves[e.key];
                  if (m) {
                    e.preventDefault();
                    move(m[0], m[1]);
                  }
                }}
              />
            </>
          )}
        </div>
        <p className="text-muted">Drag the frame to choose which part to keep. The cropped copy replaces the picture in this article.</p>
        {status === "error" && (
          <p role="alert" className="text-red-700">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            disabled={!frame || status === "working" || status === "loading"}
            onClick={apply}
            className={`${pillClass} bg-primary px-4 font-medium text-primary-foreground disabled:opacity-50`}
          >
            {status === "working" ? "Cropping…" : "Apply crop"}
          </button>
          <button type="button" onClick={onCancel} className={`${pillClass} border border-control px-4`}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document === "undefined" ? null : createPortal(dialog, document.body);
}
