import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogEditorForm, ContentMarkdownInput } from "./blog-editor-form";

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

// Blog categories audit F2 (Renato 2026-11-17, a): a new article starts
// on a blank, required "Zgjidhni kategorinë" -- never on Editorial.
describe("BlogEditorForm category select", () => {
  function renderForm(initialValues?: Parameters<typeof BlogEditorForm>[0]["initialValues"]) {
    return renderToStaticMarkup(
      createElement(BlogEditorForm, {
        action: () => {},
        staffUserId: "s",
        initialValues,
        slugReadOnly: false,
        submitLabel: "Save",
      }),
    );
  }
  function selectHtml(html: string) {
    return html.match(/<select[^>]*name="category"[\s\S]*?<\/select>/)?.[0] ?? "";
  }

  it("a new article: blank required first choice, selected; Editorial not selected", () => {
    const select = selectHtml(renderForm());
    expect(select).toMatch(/<select[^>]*required/);
    expect(select).toMatch(/<option value="" disabled="" selected="">Zgjidhni kategorinë<\/option>/);
    expect(select).not.toMatch(/<option value="editorial" selected/);
  });

  it("an existing article keeps its own category", () => {
    const select = selectHtml(
      renderForm({
        title: "t",
        slug: "t",
        excerpt: "e",
        category: "kultura",
        isEditorial: false,
        keywords: [],
        featured: false,
        seoTitle: "",
        seoDescription: "",
        contentMarkdown: "b",
        coverImageUrl: null,
      }),
    );
    expect(select).toMatch(/<option value="kultura" selected="">/);
    expect(select).not.toMatch(/<option value="" disabled="" selected="">/);
  });

  it("bs1: only the five real categories are offered; Editorial is not an option", () => {
    const select = selectHtml(renderForm());
    for (const v of ["zeja", "tregu", "kultura", "reflektime", "vleresime"]) {
      expect(select).toContain(`<option value="${v}">`);
    }
    expect(select).not.toContain('value="editorial"');
  });

  it("bs1/bs4: the Editorial tick and the Keywords box, filled from an existing article", () => {
    const html = renderForm({
      title: "t",
      slug: "t",
      excerpt: "e",
      category: "tregu",
      isEditorial: true,
      keywords: ["vetë-botim", "e-libër"],
      featured: false,
      seoTitle: "",
      seoDescription: "",
      contentMarkdown: "b",
      coverImageUrl: null,
    });
    expect(html).toMatch(/<input type="checkbox"[^>]*name="isEditorial" checked=""\/>/);
    expect(html).toMatch(/<input type="text"[^>]*name="keywords" value="vetë-botim, e-libër"\/>/);
    expect(html).toContain("2/10");
  });

  it("a new article: tick off, keywords empty", () => {
    const html = renderForm();
    expect(html).toMatch(/<input type="checkbox"[^>]*name="isEditorial"\/>/);
    expect(html).toMatch(/<input type="text"[^>]*name="keywords" value=""\/>/);
    expect(html).toContain("0/10");
  });
});
