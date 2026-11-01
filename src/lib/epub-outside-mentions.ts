import JSZip from "jszip";
import { capOutsideMentions, collectOutsideMentions, type OutsideMentions } from "@/lib/outside-mentions";

// BD3 patch 3: the same store / email / phone warning the Word
// converter gives (patch 2), for an EPUB the author uploads. Run in the
// author's browser right after the file is picked, so no download costs
// anything. Advice only: there is no reviewer check (Renato 1 Nov, 3c).
// Text only: every (X)HTML file in the archive, tags turned into spaces,
// link addresses included. Nothing is changed in the file.
//
// Browser-safe on purpose: JSZip and plain string work only (no
// node:path, no Buffer). Never throws: an archive it cannot read gives
// null, and the caller shows nothing (the author's upload still goes
// through its own checks on the server).

export type EpubOutsideScan = {
  // Every distinct mention in the book, uncapped.
  mentions: OutsideMentions;
  // The archive files they were found in, in name order (at most
  // MAX_LISTED_FILES).
  files: string[];
};

const CONTENT_FILE_RE = /\.(?:xhtml|html|htm|xht)$/i;
const MAX_CONTENT_FILES = 2_000;
const MAX_DOCUMENT_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 60_000_000;
export const MAX_LISTED_FILES = 20;

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (whole, ent: string) => {
    const lower = ent.toLowerCase();
    if (lower in NAMED) return NAMED[lower];
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
  });
}

// Blanks out comments and the content of <head>, <script> and <style>
// in one forward pass (indexOf only, so a file full of unclosed openers
// still takes linear time). An opener with no closer drops the rest.
const OPENER_RE = /<!--|<(head|script|style)(?=[\s>/])/gi;

function dropHiddenParts(xml: string): string {
  let out = "";
  let at = 0;
  OPENER_RE.lastIndex = 0;
  const lower = xml.toLowerCase();
  for (;;) {
    OPENER_RE.lastIndex = at;
    const m = OPENER_RE.exec(xml);
    if (!m) break;
    out += xml.slice(at, m.index) + " ";
    const close = m[0] === "<!--" ? "-->" : `</${m[1].toLowerCase()}`;
    const end = lower.indexOf(close, m.index + m[0].length);
    if (end < 0) return out;
    const gt = close === "-->" ? end + 3 : lower.indexOf(">", end);
    if (gt < 0) return out;
    at = close === "-->" ? gt : gt + 1;
  }
  return out + xml.slice(at);
}

const HREF_RE = /\bhref\s*=\s*(?:"([^"]{0,2048})"|'([^']{0,2048})')/gi;

export function documentText(xml: string): string {
  const visible = dropHiddenParts(xml.length > MAX_DOCUMENT_CHARS ? xml.slice(0, MAX_DOCUMENT_CHARS) : xml);
  const hrefs = [...visible.matchAll(HREF_RE)].map((m) => decodeEntities(m[1] ?? m[2] ?? "").replace(/^mailto:/i, ""));
  // [^<>]: a run of "<" with no ">" stays linear (audit r1, N2).
  return `${decodeEntities(visible.replace(/<[^<>]*>/g, " "))} ${hrefs.join(" ")}`;
}

export async function scanEpubForOutsideMentions(data: ArrayBuffer | Uint8Array): Promise<EpubOutsideScan | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return null;
  }
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && CONTENT_FILE_RE.test(name))
    .sort()
    .slice(0, MAX_CONTENT_FILES);

  const stores = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const files: string[] = [];
  let total = 0;
  try {
    for (const name of names) {
      if (total >= MAX_TOTAL_CHARS) break;
      const xml = await zip.files[name].async("string");
      total += Math.min(xml.length, MAX_DOCUMENT_CHARS);
      const found = collectOutsideMentions(documentText(xml));
      if (found.stores.length + found.emails.length + found.phones.length === 0) continue;
      found.stores.forEach((s) => stores.add(s));
      found.emails.forEach((e) => emails.add(e));
      found.phones.forEach((p) => phones.add(p));
      if (files.length < MAX_LISTED_FILES) files.push(name);
    }
  } catch {
    return null;
  }
  return { mentions: { stores: [...stores], emails: [...emails], phones: [...phones] }, files };
}

export function hasMentions(scan: EpubOutsideScan | null): boolean {
  return !!scan && scan.mentions.stores.length + scan.mentions.emails.length + scan.mentions.phones.length > 0;
}

// For display: at most MAX_LISTED of each kind.
export function listedMentions(scan: EpubOutsideScan): OutsideMentions {
  return capOutsideMentions(scan.mentions);
}
