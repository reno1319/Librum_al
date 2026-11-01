import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD6 (Renato 1 Nov: 1a its own page with the template ready to
// download, 3a a box above the Word picker with no tick, 4a only the
// support email, 5b Word steps only).
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ auth: { getUser: () => Promise.resolve({ data: { user: null } }) } }),
}));

const { default: WordGuidePage, metadata } = await import("./ndihme/word/page");
const { default: HelpPage } = await import("./ndihme/page");

const root = path.join(__dirname, "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("BD6: the Word guide page", () => {
  const html = renderToStaticMarkup(WordGuidePage());

  it("is its own page with one h1", () => {
    expect(metadata.title).toBe("Si ta përgatitni dorëshkrimin në Word");
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Si ta përgatitni dorëshkrimin në Word<\/h1>/);
  });

  it("offers the template as a download link (1a)", () => {
    const links = html.match(/<a href="\/ndihme\/word\/shablloni" download=""[^>]*>Shkarkoni shabllonin e Librum \(\.docx\)<\/a>/g);
    expect(links).toHaveLength(2);
  });

  it("ends with the support email only, no paid service (4a)", () => {
    expect(html).toContain('href="mailto:support@librum.al"');
    expect(html).not.toMatch(/lekë|pagesë|1[.,]?990|2[.,]?990|formatim me/i);
  });

  it("says the cover goes in its own field, not in the manuscript", () => {
    expect(html).toContain("Kopertinën: mos e vendosni brenda dorëshkrimit; ngarkojeni veçmas, te fusha “Imazhi i kopertinës”.");
    expect(read("src/components/cover-field.tsx")).toContain('"Imazhi i kopertinës"');
  });

  it("asks for .docx only and teaches no other app (5b)", () => {
    expect(html).toContain("Librum pranon vetëm .docx, deri në 50 MB.");
    expect(html).not.toMatch(/Google Docs|Pages|LibreOffice/);
  });
});

describe("BD6: links to the guide", () => {
  it("the Help page's file question links the guide", async () => {
    const help = renderToStaticMarkup(await HelpPage());
    expect(help).toContain('href="/ndihme/word"');
  });

  it("the Word upload box links the guide (new tab) and the template, with no tick box (3a)", () => {
    const field = read("src/components/manuscript-field.tsx");
    expect(field).toContain('import { WORD_GUIDE_PATH, WORD_TEMPLATE_PATH } from "@/lib/word-guide-paths";');
    expect(field).toMatch(/<a href=\{WORD_GUIDE_PATH\} target="_blank" rel="noopener noreferrer"/);
    expect(field).toMatch(/<a href=\{WORD_TEMPLATE_PATH\} download/);
    // The box sits in the Word branch, before the Word file picker.
    const box = field.indexOf("Para se të ngarkoni, lexoni");
    const docxPicker = field.indexOf('accept=".docx,');
    const epubPicker = field.indexOf('accept=".epub,');
    expect(box).toBeGreaterThan(epubPicker);
    expect(box).toBeLessThan(docxPicker);
    // No tick box or any other field in the box (3a), and the new tab is
    // announced to screen readers (audit r1 M10, M21).
    // Audit r2 L1: from the start of the Word branch to the Word picker,
    // the only field is the file input itself.
    const wordBranch = field.lastIndexOf("{/* BD6 (answer 3a)", box);
    expect(wordBranch).toBeGreaterThan(epubPicker);
    const beforePicker = field.slice(wordBranch, docxPicker);
    expect(beforePicker).not.toMatch(/checkbox|<select|<textarea/);
    expect(beforePicker.match(/<input\b/g)).toHaveLength(1);
    expect(beforePicker).toMatch(/<input\s+type="file"\s*$/);
    const boxSource = field.slice(box, field.indexOf("</p>", box));
    expect(boxSource).not.toMatch(/<input|<label|checkbox/);
    expect(boxSource).toContain('<span className="sr-only"> (hapet në një skedë të re)</span>');
    // The upload form never imports the JSZip template builder.
    expect(field).not.toContain("@/lib/word-template");
  });
});
