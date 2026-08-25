// Centralized policy for every post-auth "where should this send the user
// next" decision (login()'s `next` form field, the auth callback route's
// `?next=` query param). LAUNCH-1 P1: neither call site may decide this by
// substring-checking the candidate string itself (e.g. `next.startsWith("/")`
// or `!next.includes("://")`) -- those checks are exactly what let
// "//evil.com/phish" (a protocol-relative URL) and "/\evil.com/phish" (a
// backslash-host form WHATWG URL parsers treat as network-path for special
// schemes -- see below) slip through while still "starting with /".
//
// The only sound boundary is: parse the candidate as a URL against a fixed,
// synthetic same-origin base, and compare the RESULT's origin against that
// base's origin. INTERNAL_BASE is deliberately not the real production
// domain -- this function only ever validates path semantics, never touches
// the network, so what the base's host actually is doesn't matter, only
// that it's fixed and known.
const INTERNAL_BASE = new URL("https://librum.invalid");

// Resolves a caller-supplied redirect candidate to a safe, same-origin
// internal path, or null if the candidate isn't one. Never returns a full
// URL -- only pathname + search + hash, so a caller combining this with a
// trusted origin (or handing it straight to next/navigation's redirect(),
// which resolves a leading "/" against the current app) can never end up
// re-introducing an external origin by concatenation.
export function resolveSafeInternalPath(
  candidate: string | null | undefined,
): string | null {
  if (!candidate) return null;

  // Required up front, not merely a fast-path optimization: this is what
  // rejects "evil.com/path" (a schemeless, non-"/"-leading string, which
  // WHATWG relative-URL parsing would otherwise resolve AS A PATH on
  // INTERNAL_BASE -- same-origin by the check below, but not the absolute,
  // unambiguous internal path this policy is meant to only ever accept),
  // "javascript:alert(1)", "data:text/html,...", and any bare host-shaped
  // string, all without needing scheme-specific denylist logic.
  if (!candidate.startsWith("/")) return null;

  let parsed: URL;
  try {
    parsed = new URL(candidate, INTERNAL_BASE);
  } catch {
    return null;
  }

  // The actual security boundary. This is what catches "//evil.com/phish"
  // and "/\evil.com/phish" -- both begin with a single "/" (passing the
  // check above), but WHATWG URL parsing's "relative slash state" treats a
  // SECOND leading "/" *or* "\" (in any combination, since https is a
  // special scheme) as the start of a network-path reference and parses
  // "evil.com" as the host, not as path content. Real URL parsing surfaces
  // that host in `parsed.origin`; a substring check on the raw string would
  // not.
  if (parsed.origin !== INTERNAL_BASE.origin) return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
