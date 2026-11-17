import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// K7 (Renato 11-16): "Vazhdo me Google" + the one line under it, on
// /login and /signup, nothing else.
vi.mock("@/app/(public)/auth/actions", () => ({
  login: async () => undefined,
  signup: async () => undefined,
  signInWithGoogle: async () => undefined,
  signUpWithGoogle: async () => undefined,
}));
const { default: LoginPage } = await import("./page");
const { default: SignupPage } = await import("../signup/page");

const LINE =
  'Duke vazhduar me Google, pranoni <a class="focus-ring rounded-sm font-medium text-primary underline" href="/kushtet">Kushtet e përdorimit</a> dhe konfirmoni se keni lexuar <a class="focus-ring rounded-sm font-medium text-primary underline" href="/privatesia">Politikën e privatësisë</a>.';

describe("Google button", () => {
  it("login: own form with a hidden next, the button and the line", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "/library" }) }));
    const button = html.match(/<button[^>]*>(?=<svg)/)?.[0] ?? "";
    expect(button).toContain('type="submit"');
    expect(button).not.toContain("form=");
    expect(html).toContain("Vazhdo me Google");
    expect(html).toContain(LINE);
    expect(html.match(/<input type="hidden" name="next" value="\/library"\/>/g)).toHaveLength(2);
  });

  it("signup: submits the sign-up form (its role + 18+ tick), skipping the form's required fields", async () => {
    const html = renderToStaticMarkup(await SignupPage({ searchParams: Promise.resolve({}) }));
    expect(html).toMatch(/<form id="signup-form"/);
    const button = html.match(/<button[^>]*>(?=<svg)/)?.[0] ?? "";
    expect(button).toContain('form="signup-form"');
    expect(button).toMatch(/formNoValidate/i);
    expect(html).toContain(LINE);
  });
});
