import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// N2 (Renato rs1-rs3, all "a"): the resend page, and the links to it.
vi.mock("@/app/(public)/auth/actions", () => ({
  login: async () => undefined,
  signInWithGoogle: async () => undefined,
  resendConfirmationEmail: async () => undefined,
}));
const { default: ResendPage } = await import("./page");
const { default: LoginPage } = await import("../../login/page");
const { default: CheckEmailPage } = await import("../check-email/page");

const SENT =
  "Nëse ky email ka një llogari që ende nuk është konfirmuar, ju dërguam një lidhje të re. Shikoni edhe dosjen Spam.";

describe("resend confirmation page", () => {
  it("before a send: email box and an enabled button, no success line", async () => {
    const html = renderToStaticMarkup(await ResendPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Dërgoni përsëri emailin e konfirmimit");
    expect(html).toMatch(/<input type="email"[^>]*name="email"/);
    expect(html).toMatch(/<button type="submit"(?![^>]*disabled="")[^>]*>Dërgoni lidhjen<\/button>/);
    expect(html).not.toContain("ju dërguam një lidhje");
  });

  it("after a send: the one neutral line, and the button waits 60 s", async () => {
    const html = renderToStaticMarkup(
      await ResendPage({ searchParams: Promise.resolve({ success: "1" }) }),
    );
    expect(html).toContain(SENT);
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>Dërgoni përsëri pas 60 s<\/button>/);
  });

  it("an error shows only Librum's own text", async () => {
    const html = renderToStaticMarkup(
      await ResendPage({ searchParams: Promise.resolve({ error: "Shkruani emailin." }) }),
    );
    expect(html).toContain("Shkruani emailin.");
  });

  it("sign-in and «Shikoni emailin» both link to it", async () => {
    const login = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));
    expect(login).toMatch(/href="\/signup\/resend"[^>]*>Nuk ju erdhi emaili i konfirmimit\?<\/a>/);
    const check = renderToStaticMarkup(await CheckEmailPage({ searchParams: Promise.resolve({}) }));
    expect(check).toMatch(/href="\/signup\/resend"[^>]*>Dërgojeni përsëri<\/a>/);
  });
});
