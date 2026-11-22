// Blog links (Renato 2026-11-22, lk1-lk4): the rules shared by the blog
// editor's link box and the public article.
//
// - A link is a full web address (http:// or https://), a Librum
//   address that starts with "/" (what the search box saves, for example
//   /libra/<id>), a place on the same page ("#..."), or an email address
//   (mailto:, which the old link box already allowed). Nothing else (no
//   javascript:, tel:, "//other-site" or "/\other-site", no spaces).
//   The same list is used by the link box, by paste (also when copied
//   HTML is pasted) and by the public article (audit LINK-r1 F1).
// - lk3 a: on the public article, a link to another website opens in a
//   new tab; a Librum link (starting with "/", or on librum.al) and an
//   email link (audit LINK-r1 F2) open in the same tab.
//
// Pure functions, used in the browser and in the tests.

const LIBRUM_HOSTS = new Set(["librum.al", "www.librum.al"]);

// "/libra/x" yes; "//evil.example" and "/\evil.example" no (browsers
// read both as another website).
function isSiteRelative(href: string): boolean {
  return href.startsWith("/") && !href.startsWith("//") && !href.startsWith("/\\");
}

export function isAllowedBlogHref(raw: string): boolean {
  const href = raw.trim();
  if (!href || /\s/.test(href) || href.length > 2000) return false;
  if (isSiteRelative(href) || /^#[^\s#]*$/.test(href)) return true;
  if (/^mailto:[^@\s]+@[^@\s]+$/i.test(href)) return true;
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.includes(".");
  } catch {
    return false;
  }
}

// What staff type into the box: "https://..." or "/..." as typed; a bare
// "example.com/page" or "www.example.com" gets https:// in front. Returns
// null when the text is not a web address at all (then it is a search).
export function typedTextToHref(raw: string): string | null {
  const text = raw.trim();
  if (!text || /\s/.test(text)) return null;
  if (/^https?:\/\//i.test(text) || isSiteRelative(text) || /^mailto:/i.test(text)) {
    return isAllowedBlogHref(text) ? text : null;
  }
  if (/^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(text)) {
    const href = `https://${text}`;
    return isAllowedBlogHref(href) ? href : null;
  }
  return null;
}

// True for a web address on another website: the only links that open
// in a new tab on the public page (lk3 a; not email links, F2).
export function opensInNewTab(raw: string): boolean {
  const href = raw.trim();
  return /^https?:\/\//i.test(href) && isAllowedBlogHref(href) && !isLibrumHref(href);
}

// True for a link that stays on Librum (same tab on the public page).
export function isLibrumHref(raw: string): boolean {
  const href = raw.trim();
  if (isSiteRelative(href) || href.startsWith("#")) return true;
  try {
    const url = new URL(href);
    return (url.protocol === "http:" || url.protocol === "https:") && LIBRUM_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

// The link as shown in the editor's bar: without "https://" and "www.".
export function shortBlogHref(raw: string): string {
  return raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/^mailto:/i, "");
}

// The search words: spaces tidied, LIKE wildcards (% _ \) and * dropped
// so staff text can never widen the match, at most 100 characters.
export const LINK_SEARCH_MAX_LENGTH = 100;

export function cleanLinkSearchTerm(raw: string): string | null {
  const term = raw.replace(/[%_\\*]/g, " ").replace(/\s+/g, " ").trim().slice(0, LINK_SEARCH_MAX_LENGTH).trim();
  return term.length >= 2 ? term : null;
}

// Accent- and capital-blind text ("Çela" -> "cela", "Dushkë" -> "dushke"),
// the same way the bookstore and blog searches match.
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
