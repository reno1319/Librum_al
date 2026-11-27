// HEADER FIX (Renato 11-27, hd1 a): the pages that show Libraria's shop
// header (LR1, lb7 b). Every other page shows the normal header. The
// browser's current path decides, so the right header shows however you
// arrive: a typed address, a reload, or a tap on a link inside the site.
const STORE_HEADER_PATHS: ReadonlySet<string> = new Set(["/librari", "/librari/cfare-po-lexojme"]);

export function isStoreHeaderPath(pathname: string | null | undefined): boolean {
  return pathname != null && STORE_HEADER_PATHS.has(pathname);
}
