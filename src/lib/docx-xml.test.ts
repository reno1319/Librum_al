import { describe, expect, it } from "vitest";
import { decodeXmlText, escapeXmlText, getAttr, parseXml, serializeXml, XmlParseError } from "./docx-xml";

describe("W3 docx-xml", () => {
  it("writes back exactly what it read", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document xmlns:w="x"><!-- c --><w:body><w:p w:rsidR="00A"><w:r><w:t xml:space="preserve"> a &amp; b </w:t></w:r><w:br/></w:p><w:p/></w:body></w:document>`;
    expect(serializeXml(parseXml(xml))).toBe(xml);
  });

  it("refuses malformed input instead of guessing", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a>")).toThrow(XmlParseError);
    expect(() => parseXml("<a")).toThrow(XmlParseError);
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a/>')).toThrow(XmlParseError);
    expect(() => parseXml("<a><!-- open")).toThrow(XmlParseError);
    expect(() => parseXml("<".repeat(10) + "x>")).toThrow(XmlParseError);
  });

  it("refuses absurd nesting", () => {
    expect(() => parseXml("<a>".repeat(300) + "</a>".repeat(300))).toThrow(XmlParseError);
  });

  it("stays fast on hostile input", () => {
    const start = Date.now();
    expect(() => parseXml("<a b='".repeat(200_000))).toThrow();
    expect(() => parseXml("<a ".repeat(200_000))).toThrow();
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("reads attributes and entities", () => {
    const root = parseXml(`<w:jc w:val="center" x='a&amp;b'/>`);
    const el = root.children[0];
    if (el.kind !== "el") throw new Error("expected element");
    expect(getAttr(el, "w:val")).toBe("center");
    expect(getAttr(el, "x")).toBe("a&b");
    expect(getAttr(el, "val")).toBeNull();
    expect(decodeXmlText("&lt;&#233;&#x10FFFF;&#0;&bogus;")).toBe("<é\u{10FFFF}&#0;&bogus;");
    expect(escapeXmlText("a<b>&")).toBe("a&lt;b&gt;&amp;");
  });
});
