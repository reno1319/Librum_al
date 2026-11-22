// Blog picture cropping (Renato 2026-11-22, img2 a): pick a shape, then
// drag the frame to choose which part to keep. The maths is here, apart
// from the browser, so it can be tested.

export type CropShape = "original" | "wide" | "square" | "tall";
export type Rect = { x: number; y: number; width: number; height: number };

export const CROP_SHAPES: { shape: CropShape; label: string; ratio: number | null }[] = [
  { shape: "original", label: "Original", ratio: null },
  { shape: "wide", label: "Wide 3:2", ratio: 3 / 2 },
  { shape: "square", label: "Square", ratio: 1 },
  { shape: "tall", label: "Tall 2:3", ratio: 2 / 3 },
];

export function cropRatio(shape: CropShape): number | null {
  return CROP_SHAPES.find((s) => s.shape === shape)?.ratio ?? null;
}

// The biggest frame of the shape that fits the picture, centred.
// "Original" is the whole picture.
export function initialCropFrame(width: number, height: number, shape: CropShape): Rect {
  const ratio = cropRatio(shape);
  if (!ratio || width <= 0 || height <= 0) return { x: 0, y: 0, width, height };
  let w = width;
  let h = w / ratio;
  if (h > height) {
    h = height;
    w = h * ratio;
  }
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h };
}

// Moves the frame by (dx, dy) without letting it leave the picture.
export function moveCropFrame(frame: Rect, dx: number, dy: number, width: number, height: number): Rect {
  const x = Math.min(Math.max(0, frame.x + dx), Math.max(0, width - frame.width));
  const y = Math.min(Math.max(0, frame.y + dy), Math.max(0, height - frame.height));
  return { ...frame, x, y };
}

// The frame (measured on the picture as shown on screen) in the
// picture's real pixels, rounded and kept inside the picture.
export function toSourceRect(frame: Rect, shownWidth: number, naturalWidth: number, naturalHeight: number): Rect {
  const scale = shownWidth > 0 ? naturalWidth / shownWidth : 1;
  const x = Math.max(0, Math.round(frame.x * scale));
  const y = Math.max(0, Math.round(frame.y * scale));
  const width = Math.max(1, Math.min(naturalWidth - x, Math.round(frame.width * scale)));
  const height = Math.max(1, Math.min(naturalHeight - y, Math.round(frame.height * scale)));
  return { x, y, width, height };
}

// The size of the saved copy: never wider than 2400 px, so the upload
// stays well under 5 MB (the server makes it 1400 px wide anyway).
export function outputSize(source: Rect, maxWidth = 2400): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / source.width);
  return { width: Math.max(1, Math.round(source.width * scale)), height: Math.max(1, Math.round(source.height * scale)) };
}
