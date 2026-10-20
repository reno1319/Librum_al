// PEN-2: storage key shapes for the pen-names storage move (rollout step 3).
//
// New shapes (the only ones the contract migration accepts, C8/C10):
//   covers:  <random uuid>/cover.<jpg|png>
//   avatars: <random uuid>/pen-name.<jpg|png>
//
// Everything else a row can name is an old shape. The old canonical
// shapes put the account id first (`<author id>/<book id>-cover.<ext>`,
// `<account id>/avatar.<ext>`); MF6 says any other value is copied too,
// from that exact key, and counted separately as unsafe or unrecognised.
//
// A new-shape key whose folder is the row's own account id would still
// name the account, so it counts as old here (no code ever wrote one;
// this only makes the script stricter than the contract's regex).
//
// Plain erasable TypeScript only: this runs under
// `node --experimental-strip-types` (see scripts/staging-fixtures/README.md).

export const COVERS_BUCKET = "covers";
export const AVATARS_BUCKET = "avatars";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export const NEW_COVER_KEY = new RegExp(`^(${UUID})/cover\\.(jpg|png)$`);
export const NEW_PEN_NAME_PHOTO_KEY = new RegExp(`^(${UUID})/pen-name\\.(jpg|png)$`);
const OLD_CANONICAL_COVER = new RegExp(`^(${UUID})/(${UUID})-cover\\.(jpg|png|jpeg)$`, "i");
const OLD_CANONICAL_PHOTO = new RegExp(`^(${UUID})/avatar\\.(jpg|png)$`);

export type Target = "cover" | "pen_name_photo";

export type KeyClass =
  | { kind: "new" }
  // An old key the old code wrote: the account id is the folder.
  | { kind: "old"; extension: "jpg" | "png" }
  // MF6: anything else. Still copied from that exact key when its
  // extension is known; counted separately.
  | { kind: "unsafe"; extension: "jpg" | "png" | null };

export function isNewKey(target: Target, key: string): boolean {
  return (target === "cover" ? NEW_COVER_KEY : NEW_PEN_NAME_PHOTO_KEY).test(key);
}

// The extension of the old key, lowercased, with jpeg -> jpg. Null when
// it is neither (the copy then can't name a new key and is an error).
export function extensionOf(key: string): "jpg" | "png" | null {
  const match = /\.([A-Za-z]+)$/.exec(key);
  if (!match) return null;
  const ext = match[1].toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "jpg";
  if (ext === "png") return "png";
  return null;
}

// rowId is the book id for a cover (the old canonical cover key names it);
// it is not used for a pen name photo.
export function classifyKey(target: Target, key: string, accountId: string, rowId: string): KeyClass {
  const fresh = (target === "cover" ? NEW_COVER_KEY : NEW_PEN_NAME_PHOTO_KEY).exec(key);
  if (fresh && fresh[1] !== accountId) return { kind: "new" };
  const ext = extensionOf(key);
  if (target === "cover") {
    const old = OLD_CANONICAL_COVER.exec(key);
    if (old && old[1] === accountId && old[2] === rowId && ext) {
      return { kind: "old", extension: ext };
    }
  } else {
    const old = OLD_CANONICAL_PHOTO.exec(key);
    if (old && old[1] === accountId && ext) return { kind: "old", extension: ext };
  }
  return { kind: "unsafe", extension: ext };
}

export function newKey(target: Target, uuid: string, extension: "jpg" | "png"): string {
  if (!new RegExp(`^${UUID}$`).test(uuid)) throw new Error("newKey: not a lowercase uuid");
  return target === "cover" ? `${uuid}/cover.${extension}` : `${uuid}/pen-name.${extension}`;
}

export function bucketOf(target: Target): string {
  return target === "cover" ? COVERS_BUCKET : AVATARS_BUCKET;
}

// delete-old keeps every object in a new shape, referenced or not.
export function isNewShapeObject(bucket: string, name: string): boolean {
  if (bucket === COVERS_BUCKET) return NEW_COVER_KEY.test(name);
  if (bucket === AVATARS_BUCKET) return NEW_PEN_NAME_PHOTO_KEY.test(name);
  return false;
}
