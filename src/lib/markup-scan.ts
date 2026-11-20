// Linear-time scans for book files (reader speed r2, 20 Nov 2026).
//
// The sanitizers and the EPUB readers used regular expressions that are
// fast on real books but get slower with the square (or worse) of the
// input on files built on purpose: a tag start with a long run of spaces
// and no `>`, a `<?` or `<![CDATA[` that never closes, many `<body` with
// no `</body>`, and so on. 5 KB was enough to hold one request for 18 s.
//
// Each function here returns EXACTLY what the expression it replaces
// returned (same matches, same captured text, same positions), only
// without re-scanning the rest of the file for every failed start. The
// old expression is quoted above each function, and the tests compare
// both on random and hostile input.

// JavaScript's `\s`.
export function isRegexSpace(code: number): boolean {
  return (
    (code >= 0x09 && code <= 0x0d) ||
    code === 0x20 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

// `[\w:.-]`
function isNameChar(code: number): boolean {
  return isAsciiLetter(code) || (code >= 0x30 && code <= 0x39) || code === 0x5f || code === 0x3a || code === 0x2e || code === 0x2d;
}

export type MarkupToken = {
  index: number;
  // Index just past the token (the old `lastIndex`).
  end: number;
  closeName?: string;
  openName?: string;
  attrs?: string;
  selfMark?: string;
};

// Replaces, token for token:
//   /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|
//    <\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g
// Every alternative starts with `<`, and the characters after it decide
// which one can apply, so each `<` is tried once. When a closer such as
// `?>` is missing after one start it is missing after every later start
// too, which is remembered instead of searched again.
export function* markupTokens(s: string): Generator<MarkupToken> {
  const n = s.length;
  let pos = 0;
  let noCdataClose = false;
  let noPiClose = false;
  // The first `>` at or after `from`. The answer for an earlier `from`
  // still holds when it is not before `from` (or when there was none).
  let gtFrom = Infinity;
  let gtAt = -1;
  const nextGt = (from: number) => {
    if (from < gtFrom || (gtAt !== -1 && gtAt < from)) {
      gtFrom = from;
      gtAt = s.indexOf(">", from);
    }
    return gtAt;
  };

  while (pos < n) {
    const at = s.indexOf("<", pos);
    if (at === -1) return;
    const c1 = s.charCodeAt(at + 1);
    let end = -1;
    let token: MarkupToken | null = null;

    if (c1 === 0x21 /* ! */) {
      if (s.startsWith("<!--", at)) {
        const close = s.indexOf("-->", at + 4);
        end = close === -1 ? n : close + 3;
        token = { index: at, end };
      } else if (s.startsWith("<![CDATA[", at)) {
        if (!noCdataClose) {
          const close = s.indexOf("]]>", at + 9);
          if (close === -1) noCdataClose = true;
          else token = { index: at, end: close + 3 };
        }
      } else if (s.startsWith("<!DOCTYPE", at)) {
        const gt = nextGt(at + 9);
        if (gt !== -1) token = { index: at, end: gt + 1 };
      }
    } else if (c1 === 0x3f /* ? */) {
      if (!noPiClose) {
        const close = s.indexOf("?>", at + 2);
        if (close === -1) noPiClose = true;
        else token = { index: at, end: close + 2 };
      }
    } else if (c1 === 0x2f /* / */) {
      if (isAsciiLetter(s.charCodeAt(at + 2))) {
        let j = at + 3;
        while (j < n && isNameChar(s.charCodeAt(j))) j++;
        const nameEnd = j;
        while (j < n && isRegexSpace(s.charCodeAt(j))) j++;
        if (s.charCodeAt(j) === 0x3e /* > */) token = { index: at, end: j + 1, closeName: s.slice(at + 2, nameEnd) };
      }
    } else if (isAsciiLetter(c1)) {
      let j = at + 2;
      while (j < n && isNameChar(s.charCodeAt(j))) j++;
      const nameEnd = j;
      // Every part of the old open-tag expression excludes `<` and `>`,
      // so it can only end at the first `>`, with no `<` before it.
      const gt = nextGt(nameEnd);
      const lt = s.indexOf("<", at + 1);
      if (gt !== -1 && (lt === -1 || lt > gt)) {
        const openName = s.slice(at + 1, nameEnd);
        if (nameEnd === gt) {
          token = { index: at, end: gt + 1, openName, attrs: "", selfMark: "" };
        } else if (s.charCodeAt(nameEnd) === 0x2f && nameEnd + 1 === gt) {
          token = { index: at, end: gt + 1, openName, attrs: "", selfMark: "/" };
        } else if (isRegexSpace(s.charCodeAt(nameEnd))) {
          // `\s+` takes the whole run of spaces, then the lazy part takes
          // as little as it can, leaving the longest `\s*\/?` at the end.
          let w = nameEnd;
          while (w < gt && isRegexSpace(s.charCodeAt(w))) w++;
          let e = gt;
          let selfMark = "";
          if (e > w && s.charCodeAt(e - 1) === 0x2f) {
            selfMark = "/";
            e -= 1;
          }
          while (e > w && isRegexSpace(s.charCodeAt(e - 1))) e -= 1;
          token = { index: at, end: gt + 1, openName, attrs: s.slice(nameEnd, e), selfMark };
        }
      }
    }

    if (token) {
      yield token;
      pos = token.end;
    } else {
      pos = at + 1;
    }
  }
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces `xml.match(/<NAME\b[^>]*>([\s\S]*?)<\/NAME>/i)?.[1]`.
// The first `<NAME` decides: if no `>` follows it, or no `</NAME>`
// follows that `>`, no later start can do better.
export function firstElementInner(xml: string, name: string): string | undefined {
  const open = new RegExp(`<${escapeRe(name)}\\b`, "i").exec(xml);
  if (!open) return undefined;
  const gt = xml.indexOf(">", open.index + name.length + 1);
  if (gt === -1) return undefined;
  const close = new RegExp(`<\\/${escapeRe(name)}>`, "gi");
  close.lastIndex = gt + 1;
  const c = close.exec(xml);
  return c ? xml.slice(gt + 1, c.index) : undefined;
}

// Replaces `[...xml.matchAll(/<NAME\b[^>]*>([\s\S]*?)<\/NAME>/gi)].map((m) => m[1])`.
export function allElementInners(xml: string, name: string): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${escapeRe(name)}\\b`, "gi");
  const close = new RegExp(`<\\/${escapeRe(name)}>`, "gi");
  let from = 0;
  for (;;) {
    open.lastIndex = from;
    const o = open.exec(xml);
    if (!o) return out;
    const gt = xml.indexOf(">", o.index + name.length + 1);
    if (gt === -1) return out;
    close.lastIndex = gt + 1;
    const c = close.exec(xml);
    if (!c) return out;
    out.push(xml.slice(gt + 1, c.index));
    from = c.index + c[0].length;
  }
}

// Replaces the matches of /([^{}]+)\{([^{}]*)\}/g, as [selector, body].
// Every start in one run of non-brace characters meets the same next
// brace, so either the run's first character starts a rule or none of
// them does.
export function* cssRules(text: string): Generator<[string, string]> {
  const n = text.length;
  const nextBrace = (from: number) => {
    for (let i = from; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c === 0x7b || c === 0x7d) return i;
    }
    return -1;
  };
  let p = 0;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 0x7b || c === 0x7d) {
      p += 1;
      continue;
    }
    const b = nextBrace(p);
    if (b === -1) return;
    if (text.charCodeAt(b) === 0x7b) {
      const b2 = nextBrace(b + 1);
      if (b2 === -1) return;
      if (text.charCodeAt(b2) === 0x7d) {
        yield [text.slice(p, b), text.slice(b + 1, b2)];
        p = b2 + 1;
        continue;
      }
    }
    p = b + 1;
  }
}

// Replaces the group of `xml.matchAll(/<NAME\b([^>]*?)\/?>/gi)` (lazy,
// the default: a `/` right before the `>` is left out) or of
// /<NAME\b([^>]*)>/gi (greedy: kept). The group runs to the first `>`,
// and with no `>` left no later start can match either.
export function tagAttrs(xml: string, name: string, keepSlash = false): string[] {
  const out: string[] = [];
  const open = new RegExp(`<${escapeRe(name)}\\b`, "gi");
  let o: RegExpExecArray | null;
  while ((o = open.exec(xml))) {
    const start = o.index + name.length + 1;
    const gt = xml.indexOf(">", start);
    if (gt === -1) break;
    const end = !keepSlash && gt > start && xml.charCodeAt(gt - 1) === 0x2f ? gt - 1 : gt;
    out.push(xml.slice(start, end));
    open.lastIndex = gt + 1;
  }
  return out;
}

// The first match of `re` (sticky), as `xml.match(re without "y")`
// would find it, where every match of `re` begins with a match of `open`
// (global) followed by `[^>]*` (or `[^>]*?`). If a start fails, a later
// start before the next `>` fails too (the earlier start's `[^>]*` could
// take its place), so those are skipped. `closer` (global), when `re`
// must end with it, bounds the search at its last match. This removes the
// re-search from every later start, not the cost of `re` itself inside
// one long tag, so it is used only where that cost stays small (one
// open-ended part before the attribute); coverMetaContent and
// navLandmarksInner below replace the two that had more.
export function firstMatchAtTag(xml: string, open: RegExp, re: RegExp, closer?: RegExp): RegExpExecArray | null {
  let text = xml;
  if (closer) {
    let end = -1;
    let c: RegExpExecArray | null;
    closer.lastIndex = 0;
    while ((c = closer.exec(xml))) end = c.index + c[0].length;
    if (end === -1) return null;
    text = xml.slice(0, end);
  }
  open.lastIndex = 0;
  let o: RegExpExecArray | null;
  while ((o = open.exec(text))) {
    re.lastIndex = o.index;
    const m = re.exec(text);
    if (m) return m;
    const gt = text.indexOf(">", o.index);
    if (gt === -1) return null;
    open.lastIndex = gt + 1;
  }
  return null;
}

// Replaces `xml.match(/OPEN[^>]*>/gi) ?? []` for a global `open`: each
// match runs from its start to the first `>`; with no `>` left, no
// later start can match.
export function tagMatches(xml: string, open: RegExp): string[] {
  const out: string[] = [];
  open.lastIndex = 0;
  let o: RegExpExecArray | null;
  while ((o = open.exec(xml))) {
    const gt = xml.indexOf(">", o.index + o[0].length);
    if (gt === -1) break;
    out.push(xml.slice(o.index, gt + 1));
    open.lastIndex = gt + 1;
  }
  return out;
}

// Replaces `/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g` replaced by
// spaces of the same length, or null when a comment or CDATA section is
// left open (the caller's own rule). Each start is searched for its end
// once, and a start with no end means the answer is null.
export function blankCommentsAndCdata(xml: string): string | null {
  let out = "";
  let kept = 0;
  let pos = 0;
  // The next copy of each opener at or after `pos` (kept while still ahead).
  let c = -2;
  let d = -2;
  for (;;) {
    if (c !== -1 && c < pos) c = xml.indexOf("<!--", pos);
    if (d !== -1 && d < pos) d = xml.indexOf("<![CDATA[", pos);
    if (c === -1 && d === -1) break;
    const at = d === -1 || (c !== -1 && c < d) ? c : d;
    const isComment = at === c;
    const close = isComment ? xml.indexOf("-->", at + 4) : xml.indexOf("]]>", at + 9);
    if (close === -1) return null;
    const end = close + 3;
    out += xml.slice(kept, at) + " ".repeat(end - at);
    kept = end;
    pos = end;
  }
  return out + xml.slice(kept);
}

// Replaces `xml.match(/OPEN([\s\S]*?)CLOSE/)` for literal OPEN and CLOSE
// (case-sensitive): the first OPEN decides, since a CLOSE missing after
// it is missing after every later OPEN too. `start`/`end` bound the
// whole match.
export function literalBlock(xml: string, open: string, close: string): { start: number; end: number; inner: string } | null {
  const start = xml.indexOf(open);
  if (start === -1) return null;
  const c = xml.indexOf(close, start + open.length);
  if (c === -1) return null;
  return { start, end: c + close.length, inner: xml.slice(start + open.length, c) };
}

// Replaces `xml.replace(/OPEN[\s\S]*?CLOSE/, () => replacement)` for
// literal OPEN and CLOSE.
export function replaceLiteralBlock(xml: string, open: string, close: string, replacement: string): string {
  const b = literalBlock(xml, open, close);
  return b ? xml.slice(0, b.start) + replacement + xml.slice(b.end) : xml;
}

// Replaces `xml.replace(new RegExp(`${PREFIX}[^>]*/>\\n?`, "g"), "")` for
// a literal PREFIX holding no `>` and no regex characters. A copy of
// PREFIX matches when the first `>` after it has a `/` right before it;
// a later copy before that same `>` has the same answer.
export function removeSelfClosingTags(xml: string, prefix: string): string {
  let out = "";
  let kept = 0;
  let pos = 0;
  for (;;) {
    const at = xml.indexOf(prefix, pos);
    if (at === -1) break;
    const gt = xml.indexOf(">", at + prefix.length);
    if (gt === -1) break;
    if (gt - 1 >= at + prefix.length && xml.charCodeAt(gt - 1) === 0x2f) {
      const end = xml.charCodeAt(gt + 1) === 0x0a ? gt + 2 : gt + 1;
      out += xml.slice(kept, at);
      kept = end;
      pos = end;
    } else {
      pos = gt + 1;
    }
  }
  return out + xml.slice(kept);
}

// The matches of /[.!?…]+[»”’"')\]]*(?=\s|$)/g, as end positions.
// Every start inside one run of marks meets the same character after the
// marks and closers, so only the run's first mark is tried (the
// expression itself re-scanned the run from each mark: a long run of
// dots took seconds).
const SENTENCE_MARKS = new Set([".", "!", "?", "…"]);
const SENTENCE_CLOSERS = new Set(["»", "”", "’", '"', "'", ")", "]"]);
export function* sentenceEnds(text: string): Generator<number> {
  let i = 0;
  while (i < text.length) {
    if (!SENTENCE_MARKS.has(text[i])) {
      i += 1;
      continue;
    }
    let r = i;
    while (r < text.length && SENTENCE_MARKS.has(text[r])) r += 1;
    while (r < text.length && SENTENCE_CLOSERS.has(text[r])) r += 1;
    if (r === text.length || isRegexSpace(text.charCodeAt(r))) yield r;
    i = r;
  }
}

function isQuote(code: number): boolean {
  return code === 0x22 || code === 0x27;
}

// The first quote (either kind) at or after `from`, or -1.
function nextQuote(s: string, from: number): number {
  for (let i = from; i < s.length; i++) if (isQuote(s.charCodeAt(i))) return i;
  return -1;
}

// Same answer as
//   opf.match(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i)?.[1]
// without its backtracking inside one long tag (r2, audit F1: 1 MB took
// 26 s). For a `<meta` start, both `[^>]*` stay before the first `>`,
// so name and content are looked for in that stretch only. The
// expression takes the last `content=` there that comes after some
// `name="cover"` and has a value (one or more non-quote characters, then
// a quote, which may lie past the `>`). Starts before the same `>` are
// skipped as in firstMatchAtTag.
export function coverMetaContent(opf: string): string | undefined {
  const open = /<meta\b/gi;
  let lastQuote = -1;
  for (let i = opf.length - 1; i >= 0; i--) {
    if (isQuote(opf.charCodeAt(i))) {
      lastQuote = i;
      break;
    }
  }
  let o: RegExpExecArray | null;
  while ((o = open.exec(opf))) {
    const gtAt = opf.indexOf(">", o.index);
    const from = o.index + 5;
    const tag = opf.slice(from, gtAt === -1 ? opf.length : gtAt);
    const n = /\bname\s*=\s*["']cover["']/i.exec(tag);
    if (n) {
      let value = -1;
      const content = /\bcontent\s*=\s*["']/gi;
      content.lastIndex = n.index + n[0].length;
      let c: RegExpExecArray | null;
      while ((c = content.exec(tag))) {
        const v = from + c.index + c[0].length;
        if (v < opf.length && !isQuote(opf.charCodeAt(v)) && lastQuote > v) value = v;
      }
      if (value !== -1) return opf.slice(value, nextQuote(opf, value));
    }
    if (gtAt === -1) return undefined;
    open.lastIndex = gtAt + 1;
  }
  return undefined;
}

// Same answer as
//   navXml.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\blandmarks\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1]
// without its backtracking inside one long tag (r2, audit F1: 1 MB took
// 41 s). For a `<nav` start, each `epub:type=` before the first `>` has
// a fixed quoted value (up to the next quote, which may lie past that
// `>`); the tag then ends at the first `>` after that quote, and the
// inner text runs to the first `</nav>` after it. The expression takes
// the last such `epub:type=` whose value holds the word "landmarks" and
// whose inner text has an end. Values of different `epub:type=` never
// overlap (each one holds the next one's opening quote), so this is one
// pass.
export function navLandmarksInner(navXml: string): string | undefined {
  const closeRe = /<\/nav>/gi;
  let lastCloseStart = -1;
  let c: RegExpExecArray | null;
  while ((c = closeRe.exec(navXml))) lastCloseStart = c.index;
  if (lastCloseStart === -1) return undefined;
  let gtFrom = Infinity;
  let gtAt = -1;
  const nextGt = (from: number) => {
    if (from < gtFrom || (gtAt !== -1 && gtAt < from)) {
      gtFrom = from;
      gtAt = navXml.indexOf(">", from);
    }
    return gtAt;
  };
  const open = /<nav\b/gi;
  let o: RegExpExecArray | null;
  while ((o = open.exec(navXml)) && o.index < lastCloseStart) {
    const firstGt = navXml.indexOf(">", o.index);
    const from = o.index + 4;
    const tag = navXml.slice(from, firstGt === -1 ? navXml.length : firstGt);
    let best = -1;
    const type = /epub:type\s*=\s*["']/gi;
    let t: RegExpExecArray | null;
    while ((t = type.exec(tag))) {
      const v = from + t.index + t[0].length;
      const q = nextQuote(navXml, v);
      if (q === -1) break;
      if (!/\blandmarks\b/i.test(navXml.slice(v, q))) continue;
      const g = nextGt(q + 1);
      if (g !== -1 && g + 1 <= lastCloseStart) best = g;
    }
    if (best !== -1) {
      closeRe.lastIndex = best + 1;
      const close = closeRe.exec(navXml)!;
      return navXml.slice(best + 1, close.index);
    }
    if (firstGt === -1) return undefined;
    open.lastIndex = firstGt + 1;
  }
  return undefined;
}
