import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentMarkdownInput } from "./blog-editor-form";

// QA H4: saving from Preview must still submit the article body.
// Exactly one control named contentMarkdown exists in either mode, and
// it carries the typed text.

function render(showPreview: boolean, contentMarkdown: string) {
  return renderToStaticMarkup(
    createElement(ContentMarkdownInput, { showPreview, contentMarkdown, onChange: () => {} }),
  );
}

function countNamed(html: string) {
  return (html.match(/name="contentMarkdown"/g) ?? []).length;
}

describe("ContentMarkdownInput", () => {
  it("in Preview, submits the body through a hidden input and shows the rendered preview", () => {
    const html = render(true, "Teksti \"im\" & <b>më i mirë</b>");
    expect(countNamed(html)).toBe(1);
    expect(html).toContain(
      '<input type="hidden" name="contentMarkdown" value="Teksti &quot;im&quot; &amp; &lt;b&gt;më i mirë&lt;/b&gt;"/>',
    );
    expect(html).not.toContain("<textarea");
  });

  it("while editing, submits the body through the required textarea only", () => {
    const html = render(false, "Body text");
    expect(countNamed(html)).toBe(1);
    expect(html).toMatch(/<textarea[^>]*name="contentMarkdown"[^>]*required/);
    expect(html).toContain(">Body text</textarea>");
    expect(html).not.toContain('type="hidden"');
  });
});
