import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogMarkdown } from "@/components/blog-markdown";
import { blogDocToMarkdown, blogMarkdownToDoc } from "./blog-editor-markdown";

// ed3 a (2026-11-22): articles are still saved as Markdown. Opening an
// article in the new editor and saving it must not change how it looks
// on the site. Each sample goes Markdown -> editor -> Markdown and must
// show EXACTLY the same HTML on the public page.
const show = (md: string) => renderToStaticMarkup(createElement(BlogMarkdown, { markdown: md }));
const roundTrip = (md: string) => blogDocToMarkdown(blogMarkdownToDoc(md));

const ARTICLE = `Shkrimi i një libri fillon me një pyetje të thjeshtë: çfarë dua t'i them lexuesit?

## Fillo me një plan të vogël

Nuk ke nevojë për një plan të madh. Mjafton një **fletë e vetme** me tre pjesë: *fillimi*, mesi dhe fundi.

![Tryeza ku lindi drafti i parë](https://x.test/storage/v1/object/public/blog/inline/kafeja.jpg "Tryeza ku lindi drafti i parë")

- Shkruaj çdo ditë, edhe pak.
- Lexo me zë të lartë atë që shkrove.

1. një
2. dy

> "Drafti i parë është vetëm për ty."

### Rishikimi

Më shumë në [udhëzuesin tonë](https://example.test/udhezues).`;

const SAMPLES: Record<string, string> = {
  "a whole article": ARTICLE,
  "a picture with no caption": "Para.\n\n![](https://x.test/a.jpg)\n\nPas.",
  "a Half Left picture": '![Kafja](https://x.test/a.jpg#size=half&pos=left "Kafja")\n\nTeksti rreth saj.',
  "a Small Right picture": "![](https://x.test/a.jpg#size=small&pos=right)",
  "a caption with quotes and brackets": '![Ai tha "po" [1]](https://x.test/a.jpg "Ai tha \\"po\\" [1]")',
  "stars and underscores in normal text": "5 * 3 = 15, emri_i_skedarit dhe 2*2.",
  "a bare web address stays plain text": "Shiko https://librum.al sot.",
  "tildes stay plain text": "~~jo e hequr~~",
  "a line break": "rreshti një  \nrreshti dy",
  "a rule": "lart\n\n---\n\nposhtë",
  "code": "`kod` dhe\n\n```\nblloku\n```",
  "an h1": "# Titull i madh",
  "nested lists": "- a\n  - b\n- c",
  "HTML is shown as text": "<b>jo</b> <script>alert(1)</script>",
  "a heading with bold": "## Kreu **i fortë**",
  "a link with bold": "[**lidhje**](https://x.test)",
  "Albanian letters": "Ç'kemi, Ëmbëlsira, çështje",
  // ls1 a (2026-11-22): each list keeps the spacing it was written with.
  "a spaced bullet list": "Hyrje:\n\n- **Një**: e para.\n\n- **Dy**: e dyta.\n\n- Tre.\n\nPas.",
  "a spaced numbered list": "1. një\n\n2. dy\n\n3. tre",
  "a spaced numbered list starting at 4": "4. katër\n\n5. pesë",
  "a bullet list with one gap": "- a\n- b\n\n- c",
  "a numbered list with one gap": "1. a\n2. b\n\n3. c",
  "a tight list then a paragraph": "1. a\n2. b\n\nParagraf.",
  "an item with two paragraphs": "- a\n\n  vazhdim\n- b",
  "a numbered item with two paragraphs": "1. a\n\n   vazhdim\n2. b",
  "a spaced list with a tight list inside": "- a\n  - a1\n  - a2\n\n- b",
  "a tight list with a spaced list inside": "- a\n  - a1\n\n  - a2\n- b",
  "a spaced list in a quote": "> - a\n>\n> - b",
  "star bullets, spaced": "* a\n\n* b",
};

describe("new editor: open and save changes nothing on the site", () => {
  for (const [name, md] of Object.entries(SAMPLES)) {
    it(name, () => {
      expect(show(roundTrip(md))).toBe(show(md));
    });
  }

  it("a second open and save gives the very same text", () => {
    for (const md of Object.values(SAMPLES)) {
      const once = roundTrip(md);
      expect(roundTrip(once)).toBe(once);
    }
  });
});

describe("new editor: list spacing (ls1 a)", () => {
  it("saves a spaced list and a tight list exactly as written", () => {
    for (const md of ["- a\n\n- b\n\n- c", "- a\n- b\n- c", "1. a\n\n2. b", "1. a\n2. b", "Para.\n\n- a\n\n- b\n\nPas."]) {
      expect(roundTrip(md)).toBe(md);
    }
  });

  it("remembers the spacing on the list, so a new item added in a spaced list is spaced too", () => {
    const doc = blogMarkdownToDoc("- a\n\n- b");
    const list = doc.content?.[0];
    expect(list?.attrs?.loose).toBe(true);
    list?.content?.push({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] });
    expect(blogDocToMarkdown(doc)).toBe("- a\n\n- b\n\n- c");
  });

  it("a list made in the editor is tight, as before", () => {
    const item = (t: string) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: t }] }] });
    for (const type of ["bulletList", "orderedList"]) {
      const doc = { type: "doc", content: [{ type, content: [item("a"), item("b")] }] };
      expect(blogDocToMarkdown(doc)).toBe(type === "bulletList" ? "- a\n- b" : "1. a\n2. b");
    }
  });
});

describe("new editor: pictures", () => {
  it("keeps the caption, size and position", () => {
    const doc = blogMarkdownToDoc('![Kafja](https://x.test/a.jpg#size=half&pos=left "Kafja")');
    const image = JSON.stringify(doc);
    expect(image).toContain('"src":"https://x.test/a.jpg"');
    expect(image).toContain('"size":"half"');
    expect(image).toContain('"pos":"left"');
    expect(blogDocToMarkdown(doc)).toBe('![Kafja](https://x.test/a.jpg#size=half&pos=left "Kafja")');
  });

  it("a Full picture is saved with no #", () => {
    const doc = {
      type: "doc",
      content: [{ type: "image", attrs: { src: "https://x.test/a.jpg", title: "K", alt: "K", size: "full", pos: "left" } }],
    };
    expect(blogDocToMarkdown(doc)).toBe('![K](https://x.test/a.jpg "K")');
  });
});
