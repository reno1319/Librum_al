import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// SECURITY-9A (Renato, "2. a"): an author sign-up whose server-side
// switch to author failed lands here with ?author=pending and gets one
// extra line; every other sign-up sees the page as before.

const { default: CheckEmailPage } = await import("./page");

async function render(searchParams: { author?: string } = {}) {
  return renderToStaticMarkup(await CheckEmailPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("check-email page", () => {
  it("shows no extra line by default", async () => {
    const html = await render();
    expect(html).toContain("We sent you a confirmation link.");
    expect(html).not.toContain("reader account");
  });

  it("with author=pending, says to use Become an author", async () => {
    const html = await render({ author: "pending" });
    expect(html).toContain("Your account was created as a reader account.");
    expect(html).toContain("Become an author");
  });

  it("any other value shows no extra line", async () => {
    expect(await render({ author: "yes" })).not.toContain("reader account");
  });
});
