// AVATAR-STORAGE-PATH-AUTH-1: the ONE definition of a user's avatar
// Storage key, shared by the code that writes profiles.avatar_path
// (updateProfile) and the code that removes it with service-role
// authority (deleteAccount).
//
// Every avatar lives in the public "avatars" bucket at exactly
//
//   <auth user id>/avatar.<jpg|png>
//
// -- the lowercase UUID the Supabase session verified, then the literal
// "avatar.", then the extension taken from the image's verified byte
// signature (src/lib/cover-image.ts). Nothing else is canonical: no other
// folder depth, no other file name, no other extension (not "jpeg", not
// upper case), no bucket prefix, no encoding, no whitespace.
//
// The check is an exact string comparison against the two paths built
// from the caller's own id, never a parse of the stored value, so
// traversal ("../"), percent-encoding, prefix confusion ("<id>x/…",
// "<id>/../<other>/…") and a different user's id can never be accepted.

export const AVATARS_BUCKET = "avatars";

export const AVATAR_EXTENSIONS = ["jpg", "png"] as const;
export type AvatarExtension = (typeof AVATAR_EXTENSIONS)[number];

const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Builds the canonical key for `userId`. Throws on anything but a
// lowercase UUID and a supported extension, so a malformed identity can
// never produce a path.
export function canonicalAvatarPath(userId: string, extension: AvatarExtension): string {
  if (!USER_ID_PATTERN.test(userId)) {
    throw new Error("canonicalAvatarPath: user id is not a lowercase UUID");
  }
  if (!(AVATAR_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error("canonicalAvatarPath: unsupported avatar extension");
  }
  return `${userId}/avatar.${extension}`;
}

// True only when `path` is exactly one of `userId`'s own canonical avatar
// keys. Any other value -- null, empty, another user's key, a legacy or
// hand-written value -- is false, and callers holding privileged Storage
// authority must then not touch it.
export function isOwnCanonicalAvatarPath(path: unknown, userId: string): path is string {
  if (typeof path !== "string" || !USER_ID_PATTERN.test(userId)) {
    return false;
  }
  return AVATAR_EXTENSIONS.some((extension) => path === canonicalAvatarPath(userId, extension));
}
