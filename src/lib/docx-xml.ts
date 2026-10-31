// W3: a tiny XML tree for the Word clean-up pass (docx-cleanup.ts).
//
// Word's document.xml is untrusted input. This reader is deliberately
// small and linear: it walks the text once with indexOf (no regular
// expression that can backtrack), keeps every tag's attributes as the
// exact original text, and writes the tree back byte-for-byte for
// anything the clean-up pass did not touch. It does not resolve
// entities, DTDs or external references -- it never fetches anything.
// Malformed input (a closing tag that doesn't match, an unclosed tag,
// too much nesting) throws, and the caller then skips the clean-up
// pass and converts the original file as before.

export type XText = { kind: "text"; raw: string };
export type XElem = {
  kind: "el";
  name: string;
  // Everything between the tag name and ">" (or "/>"), exactly as written.
  attrs: string;
  selfClosing: boolean;
  children: XNode[];
};
export type XNode = XText | XElem;

const MAX_DEPTH = 256;

export class XmlParseError extends Error {}

export function parseXml(xml: string): XElem {
  const root: XElem = { kind: "el", name: "#root", attrs: "", selfClosing: false, children: [] };
  const stack: XElem[] = [root];
  let pos = 0;
  const len = xml.length;
  while (pos < len) {
    const lt = xml.indexOf("<", pos);
    if (lt === -1) {
      pushText(stack, xml.slice(pos));
      break;
    }
    if (lt > pos) pushText(stack, xml.slice(pos, lt));
    // Comments, processing instructions, CDATA and doctype are kept as
    // raw text so they are written back unchanged.
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new XmlParseError("unclosed comment");
      pushText(stack, xml.slice(lt, end + 3));
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new XmlParseError("unclosed cdata");
      pushText(stack, xml.slice(lt, end + 3));
      pos = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new XmlParseError("unclosed processing instruction");
      pushText(stack, xml.slice(lt, end + 2));
      pos = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // A DOCTYPE has no place in a Word part; refuse rather than guess.
      throw new XmlParseError("doctype not supported");
    }
    const gt = xml.indexOf(">", lt + 1);
    if (gt === -1) throw new XmlParseError("unclosed tag");
    const inner = xml.slice(lt + 1, gt);
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      const top = stack[stack.length - 1];
      if (stack.length === 1 || top.name !== name) throw new XmlParseError("mismatched closing tag");
      stack.pop();
      pos = gt + 1;
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameEnd = firstWhitespace(body);
    const name = nameEnd === -1 ? body : body.slice(0, nameEnd);
    if (!name || name.includes("<")) throw new XmlParseError("bad tag");
    const attrs = nameEnd === -1 ? "" : body.slice(nameEnd);
    const el: XElem = { kind: "el", name, attrs, selfClosing, children: [] };
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) throw new XmlParseError("too deep");
      stack.push(el);
    }
    pos = gt + 1;
  }
  if (stack.length !== 1) throw new XmlParseError("unclosed element");
  return root;
}

function firstWhitespace(s: string): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) return i;
  }
  return -1;
}

function pushText(stack: XElem[], raw: string) {
  if (raw) stack[stack.length - 1].children.push({ kind: "text", raw });
}

export function serializeXml(node: XNode): string {
  const out: string[] = [];
  write(node, out);
  return out.join("");
}

function write(node: XNode, out: string[]) {
  if (node.kind === "text") {
    out.push(node.raw);
    return;
  }
  if (node.name === "#root") {
    for (const c of node.children) write(c, out);
    return;
  }
  if (node.selfClosing && node.children.length === 0) {
    out.push(`<${node.name}${node.attrs}/>`);
    return;
  }
  out.push(`<${node.name}${node.attrs}>`);
  for (const c of node.children) write(c, out);
  out.push(`</${node.name}>`);
}

// ---------- helpers ----------

export function el(name: string, attrs = "", children: XNode[] = []): XElem {
  return { kind: "el", name, attrs, selfClosing: children.length === 0, children };
}

export function textNode(text: string): XText {
  return { kind: "text", raw: escapeXmlText(text) };
}

const ATTR_RE_CACHE = new Map<string, RegExp>();
export function getAttr(node: XElem, name: string): string | null {
  // Attribute values in Word parts are always double- or single-quoted.
  let re = ATTR_RE_CACHE.get(name);
  if (!re) {
    re = new RegExp(`(?:^|\\s)${name.replace(/[.:]/g, "\\$&")}\\s*=\\s*("([^"]*)"|'([^']*)')`);
    ATTR_RE_CACHE.set(name, re);
  }
  const m = node.attrs.match(re);
  if (!m) return null;
  return decodeXmlText(m[2] ?? m[3] ?? "");
}

export function childElems(node: XElem, name?: string): XElem[] {
  const out: XElem[] = [];
  for (const c of node.children) if (c.kind === "el" && (!name || c.name === name)) out.push(c);
  return out;
}

export function firstChild(node: XElem, name: string): XElem | null {
  for (const c of node.children) if (c.kind === "el" && c.name === name) return c;
  return null;
}

// Document-order search; `skip` names subtrees not to enter.
export function findAll(node: XElem, name: string, skip?: Set<string>): XElem[] {
  const out: XElem[] = [];
  walk(node, (e) => {
    if (skip?.has(e.name)) return false;
    if (e.name === name) out.push(e);
  });
  return out;
}

// Document-order walk calling `visit` for every element; returning
// false from `visit` skips that element's subtree.
export function walk(node: XElem, visit: (el: XElem, parent: XElem) => boolean | void) {
  const go = (parent: XElem) => {
    for (const c of parent.children) {
      if (c.kind !== "el") continue;
      if (visit(c, parent) === false) continue;
      go(c);
    }
  };
  go(node);
}

// Word's on/off properties: <w:b/>, <w:b w:val="1"/>, <w:b w:val="false"/>.
export function onOff(node: XElem | null): boolean | null {
  if (!node) return null;
  const v = getAttr(node, "w:val");
  if (v === null) return true;
  return !(v === "0" || v === "false" || v === "off" || v === "none");
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeXmlText(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITY[body];
  });
}

export function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
