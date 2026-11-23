import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

// AUTHOR-AGE-1 (Renato 10-24, "6. a"): the "Jam 18 vjeç ose më shumë" tick on
// the sign-up page (shown only while "Author" is chosen) and on the
// account page's "Become an author" form. The server checks are tested
// in auth/actions.test.ts and account/become-author.test.ts.

vi.mock("@/app/(public)/auth/actions", () => ({ signup: async () => undefined, signInWithGoogle: async () => undefined, signUpWithGoogle: async () => undefined }));

const { default: SignupPage } = await import("./page");

async function renderSignup(searchParams: { error?: string; role?: string } = {}) {
  return renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("sign-up page", () => {
  it("has the tick, hidden unless Author is chosen, and not browser-required", async () => {
    const html = await renderSignup();
    const tick = html.match(/<input[^>]*name="confirm_author_age"[^>]*>/)?.[0] ?? "";
    expect(tick).toContain('type="checkbox"');
    expect(tick).not.toContain("required");
    expect(html).toContain("Jam 18 vjeç ose më shumë");
    expect(html).not.toContain("18 or older");
    expect(html).toContain("hidden items-start gap-2 group-has-[[value=author]:checked]:flex");
    expect(html).toMatch(/<form[^>]*class="group /);
  });

  // BUILD 2a-1 (sg4 a, h2 b): the third choice and Renato's exact hint;
  // the 18+ box stays keyed to "Autor" only.
  it("offers Shtëpi botuese with the company-name hint, outside the 18+ box", async () => {
    const html = await renderSignup();
    expect(html).toContain('<input type="radio" name="role" value="publishing_house"/>');
    expect(html).toContain("Shtëpi botuese: dua të shes librat e shtëpisë sime botuese");
    expect(html).toContain("Nëse jeni shtëpi botuese vendosni emrin e kompanisë suaj.");
    expect(html).not.toContain("Pseudonimin mund ta vendosni më vonë");
    const box = html.slice(html.indexOf("group-has-[[value=author]:checked]:flex"));
    expect(box.slice(0, box.indexOf("</div>"))).not.toContain("publishing_house");
  });

  it("an age refusal comes back with Author chosen and the message shown", async () => {
    const html = await renderSignup({
      role: "author",
      error: "Autorët duhet të jenë 18 vjeç ose më shumë. Shënoni kutinë për ta konfirmuar.",
    });
    expect(html).toContain('<input type="radio" name="role" checked="" value="author"/>');
    expect(html).toContain("Autorët duhet të jenë 18 vjeç ose më shumë. Shënoni kutinë për ta konfirmuar.");
  });
});

describe("account page", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const source = readFileSync(path.join(root, "src/app/(public)/account/page.tsx"), "utf8");

  // BUILD 2a-1 (h5 b): one form with Autor / Shtëpi botuese; the 18+ tick
  // shows for Autor only, so it is not browser-required (becomeAuthor
  // checks it for an author).
  it("the Become an author form carries the 18+ tick with the shared wording, shown for Autor only", () => {
    const form = source.slice(source.indexOf("<form action={becomeAuthor}"), source.indexOf("Vazhdoni\n"));
    const tick = form.match(/<input[\s\S]*?name=\{AUTHOR_AGE_FIELD\}[\s\S]*?\/>/)?.[0] ?? "";
    expect(tick).toContain('type="checkbox"');
    expect(tick).not.toContain("required");
    expect(form).toContain("{AUTHOR_AGE_STATEMENT}");
    expect(form).toContain("hidden items-start gap-2 text-sm group-has-[[value=author]:checked]:flex");
    expect(form).toContain('<form action={becomeAuthor} className="group mt-3">');
    expect(form).toContain('name="become_as" value="author" defaultChecked');
    expect(form).toContain('name="become_as" value="publishing_house"');
  });

  // SECURITY-9A (Renato, "2. a"): the Terms tick sits next to the 18+ one.
  it("the Become an author form also carries a required Terms tick", () => {
    const form = source.slice(source.indexOf("<form action={becomeAuthor}"), source.indexOf("Vazhdoni\n"));
    const tick = form.match(/<input[^>]*name="accept_terms"[^>]*>/)?.[0] ?? "";
    expect(tick).toContain('type="checkbox"');
    expect(tick).toContain("required");
    expect(form).toContain('href="/kushtet"');
  });
});
