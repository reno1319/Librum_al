import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

// AUTHOR-AGE-1 (Renato 10-24, "6. a"): the "I'm 18 or older" tick on
// the sign-up page (shown only while "Author" is chosen) and on the
// account page's "Become an author" form. The server checks are tested
// in auth/actions.test.ts and account/become-author.test.ts.

vi.mock("@/app/(public)/auth/actions", () => ({ signup: async () => undefined }));

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
    expect(html).toContain("I&#x27;m 18 or older");
    expect(html).toContain("hidden items-start gap-2 group-has-[[value=author]:checked]:flex");
    expect(html).toMatch(/<form[^>]*class="group /);
  });

  it("an age refusal comes back with Author chosen and the message shown", async () => {
    const html = await renderSignup({
      role: "author",
      error: "Authors must be 18 or older. Tick the box to confirm.",
    });
    expect(html).toContain('<input type="radio" name="role" checked="" value="author"/>');
    expect(html).toContain("Authors must be 18 or older. Tick the box to confirm.");
  });
});

describe("account page", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const source = readFileSync(path.join(root, "src/app/(public)/account/page.tsx"), "utf8");

  it("the Become an author form carries a required tick with the shared wording", () => {
    const form = source.slice(source.indexOf("<form action={becomeAuthor}"), source.indexOf("Become an author\n"));
    expect(form).toContain("name={AUTHOR_AGE_FIELD}");
    expect(form).toContain('type="checkbox"');
    expect(form).toContain("required");
    expect(form).toContain("{AUTHOR_AGE_STATEMENT}");
  });

  // SECURITY-9A (Renato, "2. a"): the Terms tick sits next to the 18+ one.
  it("the Become an author form also carries a required Terms tick", () => {
    const form = source.slice(source.indexOf("<form action={becomeAuthor}"), source.indexOf("Become an author\n"));
    const tick = form.match(/<input[^>]*name="accept_terms"[^>]*>/)?.[0] ?? "";
    expect(tick).toContain('type="checkbox"');
    expect(tick).toContain("required");
    expect(form).toContain('href="/terms"');
  });
});
