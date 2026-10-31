import "server-only";
import sharp from "sharp";

// COVERS-1: every uploaded image (book cover, blog cover, pen name
// photo) is re-encoded once, at upload, before it reaches a public
// bucket. Raw uploads were stored as-is (up to 5MB each) and every page
// downloaded the full file. Each size is about 2.5x the largest place
// the image is ever shown, so it stays sharp on 2x/3x screens:
// - book cover: book page, lg:w-80 (320 CSS px)
// - blog cover: blog post page, max-w-2xl (672 CSS px)
// - pen name photo: author page, sm:size-28 (112 CSS px), always round
export const BOOK_COVER_SIZE = { width: 800 } as const;
// W7 (Renato 4b): the copy put INSIDE a Librum-made ebook only, made from
// the original upload during the save and never stored on its own. A
// tablet shows the cover full-screen, where 800px looks soft.
export const EBOOK_COVER_SIZE = { width: 1600 } as const;
export const BLOG_COVER_SIZE = { width: 1400 } as const;
export const PEN_NAME_PHOTO_SIZE = { width: 400, height: 400 } as const;
export const IMAGE_JPEG_QUALITY = 80;

// Always JPEG: the stored-path checks (books_cover_path_check,
// pen_names avatar_path check) only allow .jpg/.png, so WebP would need
// a migration, and a resized PNG photo stays large. sharp drops all
// metadata (EXIF GPS location, camera details) by default and converts
// to sRGB; rotate() first applies the EXIF orientation so a sideways
// phone photo is stored the right way up.
//
// Each new image is written to a fresh random key and never
// overwritten, so its bytes never change and browsers/CDN may keep it.
// One week, not longer (Renato's N1 a): on Supabase Free the CDN cache
// can't be purged, so a deleted cover or photo can stay reachable at its
// old URL until this runs out.
export const IMAGE_CACHE_CONTROL_SECONDS = "604800";

// Decompression-bomb guard: a 5MB PNG can declare a huge canvas. 100M
// pixels is far above any real upload (a 6000x9000 scan is 54M).
const MAX_INPUT_PIXELS = 100_000_000;

// Returns the shrunk JPEG (never enlarged, shape kept, fitting inside
// `size`), or null when the bytes passed the signature check
// (detectCoverImageKind) but can't actually be decoded.
export async function shrinkImageToJpeg(
  bytes: Buffer,
  size: { width: number; height?: number },
): Promise<Buffer | null> {
  try {
    return await sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .rotate()
      .resize({ ...size, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: IMAGE_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch {
    return null;
  }
}
