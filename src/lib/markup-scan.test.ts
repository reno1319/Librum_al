import { describe, expect, it } from "vitest";
import {
  allElementInners,
  blankCommentsAndCdata,
  coverMetaContent,
  cssRules,
  firstElementInner,
  firstMatchAtTag,
  literalBlock,
  markupTokens,
  navLandmarksInner,
  removeSelfClosingTags,
  replaceLiteralBlock,
  sentenceEnds,
  tagAttrs,
  tagMatches,
} from "./markup-scan";
import { removeDeletedXml } from "./docx-converter";
import { __internal as librumPages } from "./epub-librum-pages";

// Reader speed r2: each scan must give exactly what the expression it
// replaces gave. The old expressions are written out here and both are
// run on random strings built from the pieces that matter to them.

function rng(seed: number) {
  let s = seed;
  return (n: number) => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s % n;
  };
}

function* randomStrings(atoms: string[], count: number, seed: number, maxAtoms = 40) {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    let s = "";
    const k = 1 + r(maxAtoms);
    for (let j = 0; j < k; j++) s += atoms[r(atoms.length)];
    yield s;
  }
}

function differences<T>(inputs: Iterable<string>, oldWay: (s: string) => T, newWay: (s: string) => T): string[] {
  const bad: string[] = [];
  for (const s of inputs) {
    if (JSON.stringify(oldWay(s)) !== JSON.stringify(newWay(s))) bad.push(s);
    if (bad.length >= 3) break;
  }
  return bad;
}

const TOKEN_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;

const MARKUP_ATOMS = [
  "<", ">", "/", " ", "  ", "\t", "\n", "\u00a0", "\u2028", "a", "B", "1", "_", ":", ".", "-", "=", '"', "'", "?", "!",
  "<!--", "-->", "<![CDATA[", "]]>", "<?", "?>", "<!DOCTYPE", "</", "/>", "<p", "<a ", "</p>", "<body", "</body>",
  "<BODY>", "</Body>", "é", "x",
];

describe("markup scans give the old expressions' results", () => {
  it("markupTokens = TOKEN_RE, token for token", () => {
    const oldWay = (s: string) => {
      const out: unknown[] = [];
      const re = new RegExp(TOKEN_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(s))) out.push([m.index, re.lastIndex, m[1], m[2], m[3], m[4]]);
      return out;
    };
    const newWay = (s: string) => [...markupTokens(s)].map((t) => [t.index, t.end, t.closeName, t.openName, t.attrs, t.selfMark]);
    expect(differences(randomStrings(MARKUP_ATOMS, 150_000, 7), oldWay, newWay)).toEqual([]);
  });

  it("firstElementInner and allElementInners = the <NAME\\b[^>]*>([\\s\\S]*?)<\\/NAME> searches", () => {
    const inputs = [...randomStrings(MARKUP_ATOMS, 60_000, 11)];
    expect(
      differences(inputs, (s) => s.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1], (s) => firstElementInner(s, "body")),
    ).toEqual([]);
    expect(
      differences(
        inputs,
        (s) => [...s.matchAll(/<body\b[^>]*>([\s\S]*?)<\/body>/gi)].map((m) => m[1]),
        (s) => allElementInners(s, "body"),
      ),
    ).toEqual([]);
  });

  const TAG_ATOMS = [
    "<", ">", "/", " ", "\t", "a", "=", '"', "'", "<item", "<ITEM ", "<items", "/>", "<nav", "<nav ", "epub:type",
    'epub:type="', "landmarks", " landmarks", "</nav>", "</NAV>", "<meta ", 'name="cover"', "name='cover'", ' content="x"',
    "content='y'", "<rootfile ", 'full-path="o.opf"', "x", "<a", "<a ", "<opf:item ", "<opf:package ", 'version="3.0"',
    "<itemref ", 'idref="c"', "<reference ", "<opf:reference ",
  ];

  it("tagAttrs and tagMatches = the <NAME\\b[^>]*> searches", () => {
    const inputs = [...randomStrings(TAG_ATOMS, 60_000, 3)];
    expect(differences(inputs, (s) => [...s.matchAll(/<item\b([^>]*?)\/?>/gi)].map((m) => m[1]), (s) => tagAttrs(s, "item"))).toEqual([]);
    expect(differences(inputs, (s) => [...s.matchAll(/<a\b([^>]*)>/gi)].map((m) => m[1]), (s) => tagAttrs(s, "a", true))).toEqual([]);
    expect(
      differences(
        inputs,
        (s) => s.match(/<([a-zA-Z0-9]+:)?reference\b[^>]*>/gi) ?? [],
        (s) => tagMatches(s, /<([a-zA-Z0-9]+:)?reference\b/gi),
      ),
    ).toEqual([]);
  });

  it("firstMatchAtTag = the first match of each tag expression", () => {
    const inputs = [...randomStrings(TAG_ATOMS, 60_000, 4)];
    const cases: [RegExp, RegExp, RegExp | undefined][] = [
      [/<rootfile\b[^>]*\bfull-path\s*=\s*(["'])(.*?)\1/i, /<rootfile\b/gi, undefined],
      [/<([a-zA-Z0-9]+:)?package\b[^>]*\bversion\s*=\s*["']([0-9.]+)["']/i, /<([a-zA-Z0-9]+:)?package\b/gi, undefined],
      [/<([a-zA-Z0-9]+:)?itemref\b[^>]*?\bidref\s*=\s*["']([^"']+)["'][^>]*?\/?>/i, /<([a-zA-Z0-9]+:)?itemref\b/gi, undefined],
      [/<([a-zA-Z0-9]+:)?item\b[^>]*\bid\s*=\s*["']c["'][^>]*>/i, /<([a-zA-Z0-9]+:)?item\b/gi, undefined],
    ];
    for (const [re, open, closer] of cases) {
      const sticky = new RegExp(re.source, `${re.flags}y`);
      expect(
        differences(
          inputs,
          (s) => {
            const m = s.match(re);
            return m && [m.index, ...m];
          },
          (s) => {
            const m = firstMatchAtTag(s, open, sticky, closer);
            return m && [m.index, ...m];
          },
        ),
      ).toEqual([]);
    }
    const manifest = /<([a-zA-Z0-9]+:)?manifest\b[^>]*>([\s\S]*?)<\/([a-zA-Z0-9]+:)?manifest\s*>/i;
    const manifestInputs = [...randomStrings(["<manifest", "<opf:manifest", ">", " ", "x", "</manifest>", "</opf:manifest >", "</manifest\n>", "<"], 60_000, 5)];
    expect(
      differences(
        manifestInputs,
        (s) => {
          const m = s.match(manifest);
          return m && [m.index, ...m];
        },
        (s) => {
          const m = firstMatchAtTag(s, /<([a-zA-Z0-9]+:)?manifest\b/gi, new RegExp(manifest.source, "iy"), /<\/([a-zA-Z0-9]+:)?manifest\s*>/gi);
          return m && [m.index, ...m];
        },
      ),
    ).toEqual([]);
  });

  it("coverMetaContent and navLandmarksInner = the cover-meta and landmarks expressions (r2)", () => {
    const meta = /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i;
    const metaAtoms = ["<meta", "<META ", "<metax", " ", ">", '"', "'", "x", "=", "name", " name", ' name="cover"', " name='COVER'", " name = 'cover'", "content", " content", ' content="', " content='", ' content="a"', "a", "<", "/", "\t"];
    for (const seed of [21, 22]) {
      expect(differences(randomStrings(metaAtoms, 80_000, seed), (s) => s.match(meta)?.[1], coverMetaContent)).toEqual([]);
    }
    const nav = /<nav\b[^>]*epub:type\s*=\s*["'][^"']*\blandmarks\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i;
    const navAtoms = ["<nav", "<NAV ", "<navx", " ", ">", '"', "'", "x", "=", "epub:type", " epub:type", ' epub:type="', " epub:type = '", "landmarks", " landmarks", "LANDMARKS ", "xlandmarks", "</nav>", "</NAV>", "<", "/", "a"];
    for (const seed of [23, 24]) {
      expect(differences(randomStrings(navAtoms, 80_000, seed), (s) => s.match(nav)?.[1], navLandmarksInner)).toEqual([]);
    }
  });

  it("cssRules = /([^{}]+)\\{([^{}]*)\\}/g", () => {
    const inputs = randomStrings(["{", "}", "a", " ", ".x", ";", "color:red", "\n"], 80_000, 6);
    expect(differences(inputs, (s) => [...s.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1], m[2]]), (s) => [...cssRules(s)])).toEqual([]);
  });

  it("blankCommentsAndCdata = the comment/CDATA blanking with its unclosed check", () => {
    const oldWay = (xml: string) => {
      const masked = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => " ".repeat(m.length));
      return /<!--|<!\[CDATA\[/.test(masked) ? null : masked;
    };
    const inputs = randomStrings(["<!--", "-->", "<![CDATA[", "]]>", "x", "-", ">", "<!-", "]"], 80_000, 8);
    expect(differences(inputs, oldWay, blankCommentsAndCdata)).toEqual([]);
    expect(librumPages.maskComments("a<!--b-->c")).toBe("a        c");
  });

  it("literal blocks and self-closing tag removal = their expressions", () => {
    const atoms = ["<dc:title>", "</dc:title>", "x", "<", ">", "/", "/>", '<item id="c"', '<item id="c"/>', "\n", " "];
    const inputs = [...randomStrings(atoms, 60_000, 9)];
    expect(differences(inputs, (s) => s.match(/<dc:title>([\s\S]*?)<\/dc:title>/)?.[1], (s) => literalBlock(s, "<dc:title>", "</dc:title>")?.inner)).toEqual([]);
    expect(
      differences(inputs, (s) => s.replace(/<dc:title>[\s\S]*?<\/dc:title>/, () => "T$&"), (s) => replaceLiteralBlock(s, "<dc:title>", "</dc:title>", "T$&")),
    ).toEqual([]);
    expect(differences(inputs, (s) => s.replace(/<item id="c"[^>]*\/>\n?/g, ""), (s) => removeSelfClosingTags(s, '<item id="c"'))).toEqual([]);
  });

  it("removeDeletedXml = the tracked-changes expression", () => {
    const re = /<w:(del|moveFrom)\b[^>]*\/>|<w:(del|moveFrom)\b(?:[^>]*[^>/])?>[\s\S]*?<\/w:\2>/g;
    const atoms = ["<w:del>", "<w:del ", "<w:del/>", "<w:del a='1'/>", "</w:del>", "<w:moveFrom>", "</w:moveFrom>", "<w:delText>", "<w:del-x>", ">", "/", "x", " ", "<w:r>", "</w:del >", "<W:del>", "/>"];
    expect(differences(randomStrings(atoms, 100_000, 10), (s) => s.replace(re, ""), removeDeletedXml)).toEqual([]);
  });

  it("sentenceEnds = the sentence-end expression's match ends", () => {
    const re = /[.!?…]+[»”’"')\]]*(?=\s|$)/g;
    const inputs = randomStrings([".", "!", "?", "…", "»", "”", "’", '"', "'", ")", "]", " ", "\n", "a", "\u00a0"], 80_000, 12);
    expect(differences(inputs, (s) => [...s.matchAll(re)].map((m) => m.index + m[0].length), (s) => [...sentenceEnds(s)])).toEqual([]);
  });

  it("the pre-paginated check and the free id = their old forms", () => {
    const inputs = [...randomStrings(["rendition:layout", "pre-paginated", "PRE-PAGINATED", "<", " ", "x", ":"], 60_000, 13, 12)];
    expect(differences(inputs, (s) => /rendition:layout[^<]*pre-paginated/i.test(s), librumPages.hasPrePaginatedLayout)).toEqual([]);
    const ids = [
      ...randomStrings(
        [' id="librum-front"', " id='librum-front-2'", ' id = "librum-front-3"', 'xid="librum-front"', ' id="librum-front-x"', " ", ' x id = "', "id='", "librum-front", "'", '"', "-2", " id="],
        60_000,
        14,
        10,
      ),
    ];
    const oldUnique = (opf: string) => {
      let id = "librum-front";
      for (let n = 2; new RegExp(`\\bid\\s*=\\s*["']${id}["']`).test(opf); n++) id = `librum-front-${n}`;
      return id;
    };
    expect(differences(ids, oldUnique, (s) => librumPages.uniqueId(s, "librum-front"))).toEqual([]);
  });
});

// Files built on purpose: each took seconds or more before (measured on
// the old expressions, 20 Nov 2026), and each must now stay fast.
describe("crafted input stays fast", () => {
  const fast = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  const MB = 2_000_000;

  it("the tokenizer", () => {
    for (const s of [
      `<a${" ".repeat(MB)}<`, // 5 KB of this took 18 s
      `<a x${" ".repeat(MB)}y>`,
      "<?".repeat(MB / 2),
      "<![CDATA[".repeat(MB / 9),
      "<!DOCTYPE".repeat(MB / 9),
      "<a<a".repeat(MB / 4),
    ]) {
      expect(fast(() => [...markupTokens(s)])).toBeLessThan(2000);
    }
  });

  it("element, tag and rule searches", () => {
    expect(fast(() => firstElementInner(`</body>${"<body>".repeat(MB / 6)}`, "body"))).toBeLessThan(2000);
    expect(fast(() => allElementInners("<style>".repeat(MB / 7), "style"))).toBeLessThan(2000);
    expect(fast(() => tagAttrs("<link".repeat(MB / 5), "link"))).toBeLessThan(2000);
    expect(
      fast(() => navLandmarksInner(`${'<nav epub:type="'.repeat(MB / 16)}"></nav>`)),
    ).toBeLessThan(2000);
    // r2 (audit F1): ONE long tag. 1 MB took 26 s and 41 s before.
    expect(fast(() => coverMetaContent(`<meta${' name="cover"'.repeat(MB / 13)}`))).toBeLessThan(2000);
    expect(fast(() => navLandmarksInner(`<nav epub:type="${"landmarks ".repeat(MB / 10)}</nav>`))).toBeLessThan(2000);
    expect(fast(() => [...cssRules("a".repeat(400_000))])).toBeLessThan(2000);
    expect(fast(() => blankCommentsAndCdata("<!--".repeat(MB / 4)))).toBeLessThan(2000);
    expect(fast(() => librumPages.hasPrePaginatedLayout("rendition:layout ".repeat(MB / 17)))).toBeLessThan(2000);
    expect(fast(() => librumPages.uniqueId(Array.from({ length: 30_000 }, (_, i) => ` id="librum-front-${i + 2}"`).join("") + ' id="librum-front"', "librum-front"))).toBeLessThan(2000);
    expect(fast(() => literalBlock(`</dc:title>${"<dc:title>".repeat(MB / 10)}`, "<dc:title>", "</dc:title>"))).toBeLessThan(2000);
    expect(fast(() => removeSelfClosingTags('<item id="c"'.repeat(MB / 12), '<item id="c"'))).toBeLessThan(2000);
    expect(fast(() => removeDeletedXml("<w:del-x></w:del-x>".repeat(MB / 19)))).toBeLessThan(2000);
    expect(fast(() => [...sentenceEnds(".".repeat(MB))])).toBeLessThan(2000);
  });
});
