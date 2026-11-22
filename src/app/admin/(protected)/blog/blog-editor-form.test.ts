import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogEditorForm } from "./blog-editor-form";
import { BlogContentEditor } from "./blog-content-editor";

// Patch B: the page passes the categories from blog_categories, in
// their set order, Editorial left out.
const TEST_CATEGORIES = [
  { value: "zeja", label: "Zeja e Shkrimit" },
  { value: "tregu", label: "Tregu i Librit & Botimet" },
  { value: "perkthime", label: "Përkthime" },
  { value: "kultura", label: "Kulturë & Njohuri" },
  { value: "reflektime", label: "Reflektime & Frymëzim" },
  { value: "vleresime", label: "Vlerësimet & Rekomandimet" },
];

// ed3 a (2026-11-22): one editing box, no preview box beside it. The
// article goes to the server in exactly one hidden field named
// contentMarkdown, carrying the Markdown exactly as given (staff who
// change nothing send it back unchanged). A hidden field is never
// `required`, so it can never silently block a save; the server still
// refuses an empty article ("Content is required.").
describe("BlogContentEditor", () => {
  function render(contentMarkdown: string) {
    return renderToStaticMarkup(
      createElement(BlogContentEditor, { staffUserId: "s", contentMarkdown, onChange: () => {} }),
    );
  }

  it("sends the article in one hidden contentMarkdown field, unchanged", () => {
    const html = render('Teksti **im** & "yt"');
    expect((html.match(/name="contentMarkdown"/g) ?? []).length).toBe(1);
    expect(html).toContain('<input type="hidden" name="contentMarkdown" value="Teksti **im** &amp; &quot;yt&quot;"/>');
    expect(html).not.toMatch(/required/);
  });

  it("has no preview box and no Write/Preview switch", () => {
    const html = render("Body");
    expect(html).not.toContain('aria-label="Preview"');
    expect(html).not.toContain("Write or preview");
    expect(html).not.toContain("<textarea");
  });

  it("keeps the same buttons as before", () => {
    const html = render("Body");
    for (const title of ["Bold", "Italic", "Heading", "Small heading", "Bulleted list", "Numbered list", "Quote", "Link", "Image"]) {
      expect(html).toContain(`title="${title}"`);
    }
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
        categories: TEST_CATEGORIES,
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
        authorName: "",
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

  it("patch B: exactly the categories passed in, in that order; Editorial is not an option", () => {
    const select = selectHtml(renderForm());
    const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(["zeja", "tregu", "perkthime", "kultura", "reflektime", "vleresime"]);
    expect(select).toContain('<option value="perkthime">Përkthime</option>');
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
      authorName: "Arben Hoxha",
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

  it("au1: the Written by box sits between the Editorial tick and Keywords, filled from the article", () => {
    const html = renderForm({
      title: "t",
      slug: "t",
      excerpt: "e",
      category: "tregu",
      isEditorial: false,
      keywords: [],
      authorName: "Arben Hoxha",
      featured: false,
      seoTitle: "",
      seoDescription: "",
      contentMarkdown: "b",
      coverImageUrl: null,
    });
    expect(html).toMatch(/<input(?=[^>]*name="authorName")(?=[^>]*value="Arben Hoxha")[^>]*>/);
    expect(html).toContain("Written by (optional)");
    expect(html).toContain("Nga Arben Hoxha");
    const tick = html.indexOf('name="isEditorial"');
    const box = html.indexOf('name="authorName"');
    expect(tick).toBeGreaterThan(-1);
    expect(box).toBeGreaterThan(tick);
    expect(html.indexOf('name="keywords"')).toBeGreaterThan(box);
  });

  it("a new article: tick off, keywords empty", () => {
    const html = renderForm();
    expect(html).toMatch(/<input type="checkbox"[^>]*name="isEditorial"\/>/);
    expect(html).toMatch(/<input type="text"[^>]*name="keywords" value=""\/>/);
    expect(html).toContain("0/10");
    expect(html).toMatch(/<input(?=[^>]*name="authorName")(?=[^>]*value="")[^>]*>/);
  });
});
