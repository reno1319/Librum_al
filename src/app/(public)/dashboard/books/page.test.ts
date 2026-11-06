import { describe, expect, it, vi } from "vitest";

// BD15 P6 (Renato 11-05, Q1 a): /dashboard/books only redirects to the
// one bookshelf on /dashboard, before any Supabase call.
const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));
const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: AllBooksPage } = await import("./page");

describe("AllBooksPage: redirects to the Dashboard bookshelf", () => {
  it("redirects to /dashboard and reads nothing", () => {
    expect(() => AllBooksPage()).toThrow("REDIRECT:/dashboard");
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the page source makes no Supabase call of its own", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("supabase");
    expect(source).toContain('redirect("/dashboard")');
  });
});
