import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// CART (item 32, c2 a, p1 c): the bag with the cart's number, for a
// signed-in reader only, from 1024px up; on phones the same number goes
// to the menu's "Shporta" line. Never for a visitor or during a password
// recovery session.
let user: { id: string; email: string } | null = null;
let recovery = false;
let cartCount: number | null = 0;
const cartQueries: { filters: [string, unknown][]; head: boolean }[] = [];
const menuProps: { cartCount?: number | null }[] = [];

function chainFor(table: string) {
  if (table === "cart_items") {
    const q = { filters: [] as [string, unknown][], head: false };
    cartQueries.push(q);
    const chain = {
      select: (_cols: string, opts?: { head?: boolean }) => {
        q.head = !!opts?.head;
        return chain;
      },
      eq: (col: string, value: unknown) => {
        q.filters.push([col, value]);
        return Promise.resolve({ count: cartCount, error: null });
      },
    };
    return chain;
  }
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: { display_name: "Ana", role: "reader" }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => chainFor(table),
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/recovery-session", () => ({ isRecoverySessionActive: () => recovery }));
vi.mock("@/app/(public)/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/components/nav-links", () => ({ NavLinks: () => null }));
vi.mock("@/components/mobile-nav", () => ({
  MobileNav: (props: { cartCount?: number | null }) => {
    menuProps.push(props);
    return null;
  },
}));
vi.mock("@/components/feedback-button", () => ({ FeedbackButton: () => null }));

const { SiteHeader } = await import("./site-header");

async function render(): Promise<string> {
  return renderToStaticMarkup((await SiteHeader()) as ReactElement);
}

describe("SiteHeader cart", () => {
  beforeEach(() => {
    user = { id: "reader-1", email: "ana@example.test" };
    recovery = false;
    cartCount = 0;
    cartQueries.length = 0;
    menuProps.length = 0;
  });

  it("signed in with 3 rows: the bag (computers only) shows 3, the menu gets 3; reads only the reader's own rows", async () => {
    cartCount = 3;
    const html = await render();
    expect(html).toMatch(/<a [^>]*aria-label="Shporta, 3 libra"[^>]*class="[^"]*hidden[^"]*lg:flex[^"]*"[^>]*href="\/shporta"|<a [^>]*href="\/shporta"[^>]*aria-label="Shporta, 3 libra"[^>]*class="[^"]*hidden[^"]*lg:flex/);
    expect(html).toContain(">3</span>");
    expect(cartQueries).toEqual([{ filters: [["reader_id", "reader-1"]], head: true }]);
    expect(menuProps.at(-1)?.cartCount).toBe(3);
  });

  it("an empty cart: the bag has no number", async () => {
    const html = await render();
    expect(html).toContain('aria-label="Shporta"');
    expect(menuProps.at(-1)?.cartCount).toBe(0);
  });

  it("a failed count shows the bag with no number", async () => {
    cartCount = null;
    const html = await render();
    expect(html).toContain('aria-label="Shporta"');
  });

  it("over 99 shows 99+", async () => {
    cartCount = 120;
    expect(await render()).toContain(">99+</span>");
  });

  it("signed out: no bag, no cart read, no menu line", async () => {
    user = null;
    const html = await render();
    expect(html).not.toContain("/shporta");
    expect(cartQueries).toHaveLength(0);
    expect(menuProps.at(-1)?.cartCount).toBeNull();
  });

  it("password recovery: no bag, no cart read, no menu line", async () => {
    recovery = true;
    const html = await render();
    expect(html).not.toContain("/shporta");
    expect(cartQueries).toHaveLength(0);
    expect(menuProps.at(-1)?.cartCount).toBeNull();
  });
});
