// AVATAR-STORAGE-PATH-AUTH-1: test-only data shared by
// src/lib/avatar-path.test.ts and src/app/(public)/account/
// avatar-deletion.test.ts, so the rule and the privileged remover are
// exercised against the same hostile values. Imported by no application
// code.
import { AVATARS_BUCKET } from "./avatar-path";

export const AVATAR_FIXTURE_USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
export const AVATAR_FIXTURE_OTHER_ID = "b2c3d4e5-2222-4222-8222-abcdef222222";

const USER = AVATAR_FIXTURE_USER_ID;
const OTHER = AVATAR_FIXTURE_OTHER_ID;

// Every value deleteAccount must refuse to hand to service-role removal
// for USER, as [label, stored avatar_path].
export const UNSAFE_AVATAR_PATHS_FOR_USER: [string, unknown][] = [
  ["empty", ""],
  ["whitespace", "   "],
  ["another user's canonical png", `${OTHER}/avatar.png`],
  ["another user's canonical jpg", `${OTHER}/avatar.jpg`],
  ["prefix confusion: longer first segment", `${USER}x/avatar.png`],
  ["prefix confusion: id as a prefix of the file name", `${USER}avatar.png`],
  ["prefix confusion: other id after own", `${USER}/${OTHER}/avatar.png`],
  ["prefix confusion: own id nested under other", `${OTHER}/${USER}/avatar.png`],
  ["traversal to another user", `${USER}/../${OTHER}/avatar.png`],
  ["dot segment", `${USER}/./avatar.png`],
  ["encoded traversal", `${USER}/..%2F${OTHER}/avatar.png`],
  ["double-encoded traversal", `${USER}/%252e%252e%252f${OTHER}/avatar.png`],
  ["encoded slash", `${USER}%2Favatar.png`],
  ["backslash", `${USER}\\avatar.png`],
  ["leading slash", `/${USER}/avatar.png`],
  ["leading dot-slash", `./${USER}/avatar.png`],
  ["double slash", `${USER}//avatar.png`],
  ["trailing slash", `${USER}/avatar.png/`],
  ["bucket-qualified", `${AVATARS_BUCKET}/${USER}/avatar.png`],
  ["wrong bucket prefix", `manuscripts/${USER}/avatar.png`],
  ["temp staging key", `${USER}/tmp/avatar/x.png`],
  ["extra depth", `${USER}/a/avatar.png`],
  ["no folder", "avatar.png"],
  ["folder only", `${USER}/`],
  ["bare id", USER],
  ["jpeg spelling", `${USER}/avatar.jpeg`],
  ["upper-case extension", `${USER}/avatar.PNG`],
  ["upper-case id", `${USER.toUpperCase()}/avatar.png`],
  ["unsupported extension", `${USER}/avatar.gif`],
  ["svg", `${USER}/avatar.svg`],
  ["different file name", `${USER}/photo.png`],
  ["double extension", `${USER}/avatar.png.png`],
  ["query suffix", `${USER}/avatar.png?x=1`],
  ["fragment suffix", `${USER}/avatar.png#x`],
  ["NUL byte", `${USER}/avatar.png\u0000`],
  ["trailing newline", `${USER}/avatar.png\n`],
  ["leading space", ` ${USER}/avatar.png`],
  ["unicode lookalike slash", `${USER}∕avatar.png`],
  ["number", 42],
  ["array holding the canonical key", [`${USER}/avatar.png`]],
  ["object", { path: `${USER}/avatar.png` }],
  ["undefined", undefined],
  ["null", null],
];
