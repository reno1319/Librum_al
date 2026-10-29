// PEN-NAMES-1 (migration 20261019184512): a pen name is the public
// identity readers see -- its own id, name, bio, photo and links. Every
// reader-facing page reads pen names through the public_pen_names view,
// which has no author_id, and links to /autore/<pen name id>.
//
// Release rule: this alone does NOT hide the account behind a pen name
// (books.author_id and public_author_profiles stay public until PR B),
// so it must not reach Production without PR B.

export const PEN_NAME_MAX_LENGTH = 120;
export const PEN_NAME_MAX_LINKS = 3;
export const PEN_NAME_LINK_MAX_LENGTH = 500;
// The bio has no database limit (as profiles.bio); the form keeps one
// post reasonable.
export const PEN_NAME_BIO_MAX_LENGTH = 5000;
// The same 5 MB limit as the profile photo (avatars bucket).
export const PEN_NAME_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

// One row of public.public_pen_names.
export type PublicPenName = {
  id: string;
  name: string;
  bio: string | null;
  avatar_path: string | null;
  links: unknown;
};

// The embed every book/series/bundle query uses for its pen name.
export type PenNameRef = { id: string; name: string };

// The author's own row (session client; RLS shows only their own).
export type OwnPenName = {
  id: string;
  name: string;
  bio: string | null;
  avatar_path: string | null;
  links: unknown;
  is_default: boolean;
  created_at: string;
};

export function authorPagePath(penNameId: string): string {
  return `/autore/${penNameId}`;
}

// links is jsonb: only well-formed https strings are ever rendered, even
// if a stored value were somehow anything else.
export function readPenNameLinks(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  return links
    .filter((link): link is string => typeof link === "string" && isAllowedPenNameLink(link))
    .slice(0, PEN_NAME_MAX_LINKS);
}

export function isAllowedPenNameLink(value: string): boolean {
  if (value.length === 0 || value.length > PEN_NAME_LINK_MAX_LENGTH) return false;
  if (!value.startsWith("https://") || /\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

// A link's visible text: the host and path, without the scheme.
export function penNameLinkLabel(link: string): string {
  try {
    const url = new URL(link);
    const path = url.pathname === "/" ? "" : url.pathname;
    return `${url.hostname}${path}`;
  } catch {
    return link;
  }
}

export type PenNameLinksResult = { ok: true; links: string[] } | { ok: false; message: string };

// Server-side validation of the Pen names form's link boxes: empty boxes
// are dropped, at most 3, each https only (8a).
export function parsePenNameLinks(values: readonly unknown[]): PenNameLinksResult {
  const links = values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value !== "");
  if (links.length > PEN_NAME_MAX_LINKS) {
    return { ok: false, message: `Shtoni deri në ${PEN_NAME_MAX_LINKS} lidhje.` };
  }
  for (const link of links) {
    if (!isAllowedPenNameLink(link)) {
      return { ok: false, message: "Çdo lidhje duhet të jetë një adresë e plotë interneti që fillon me https://." };
    }
  }
  if (new Set(links).size !== links.length) {
    return { ok: false, message: "Çdo lidhje mund të shtohet vetëm një herë." };
  }
  return { ok: true, links };
}

export type PenNameNameResult = { ok: true; name: string } | { ok: false; message: string };

export function parsePenNameName(value: unknown): PenNameNameResult {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name) return { ok: false, message: "Pseudonimi nuk mund të jetë bosh." };
  if (name.length > PEN_NAME_MAX_LENGTH) {
    return { ok: false, message: `Pseudonimi mund të ketë deri në ${PEN_NAME_MAX_LENGTH} karaktere.` };
  }
  return { ok: true, name };
}

// The database's own refusals (migration 20261019184512), as the words
// an author sees. Anything else is the caller's generic message (a
// unique violation, 23505, is mapped only where the caller knows it is
// the pen name's own name index).
export const PEN_NAME_MIXED_MESSAGE =
  "Një seri ose paketë mban vetëm libra me të njëjtin pseudonim. Zgjidhni libra me të njëjtin pseudonim.";
export const PEN_NAME_LOCKED_MESSAGE =
  "Ky libër është në një seri ose paketë. Hiqeni prej saj më parë, pastaj ndryshoni pseudonimin.";
export const PEN_NAME_TAKEN_MESSAGE =
  "Këtë emër e përdorni tashmë si një nga pseudonimet tuaja. Zgjidhni një emër tjetër, ose ndryshoni më parë emrin e atij pseudonimi.";

export function penNameErrorMessage(error: { code?: string | null } | null | undefined): string | null {
  switch (error?.code) {
    case "LB451":
      return PEN_NAME_MIXED_MESSAGE;
    case "LB452":
      return PEN_NAME_LOCKED_MESSAGE;
    case "LB453":
      return PEN_NAME_TAKEN_MESSAGE;
    default:
      return null;
  }
}
