// PEN-NAMES-1 (migration 20261019184512): the ONE definition of a pen
// name photo's Storage key. It lives in the public "avatars" bucket at
//
//   <random uuid>/pen-name.<jpg|png>
//
// -- a fresh server-generated folder per upload, never the account id, so
// the photo's address does not name the account behind the pen name (9a).
// The database's own check (pen_names_avatar_path_check) accepts exactly
// this shape. Only the server writes it (service role); authenticated
// may not write pen_names.avatar_path.

export const PEN_NAME_PHOTO_EXTENSIONS = ["jpg", "png"] as const;
export type PenNamePhotoExtension = (typeof PEN_NAME_PHOTO_EXTENSIONS)[number];

const FOLDER_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PATH_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/pen-name\.(jpg|png)$/;

export function canonicalPenNamePhotoPath(folderId: string, extension: PenNamePhotoExtension): string {
  if (!FOLDER_PATTERN.test(folderId)) {
    throw new Error("canonicalPenNamePhotoPath: folder is not a lowercase UUID");
  }
  if (!(PEN_NAME_PHOTO_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error("canonicalPenNamePhotoPath: unsupported extension");
  }
  return `${folderId}/pen-name.${extension}`;
}

// True only for a value of exactly the canonical shape. Callers with
// service-role Storage authority also take the value only from the
// author's OWN pen_names rows.
export function isPenNamePhotoPath(path: unknown): path is string {
  return typeof path === "string" && PATH_PATTERN.test(path);
}
