import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// Dashboard batch 1 (b1q3 a): the thin staff-only bar above the public
// header. Only someone with their own staff_members row sees it; never a
// visitor, a reader or an author without a row, and never during a
// password-recovery session. "+ Postim i ri" only for blog.manage roles.
type StaffRead = { data: { role: string } | null; error: { message: string } | null };
let user: { id: string; email: string } | null = null;
let staffRead: StaffRead = { data: null, error: null };
let recovery = false;
const staffQueries: { select: string; filters: [string, unknown][] }[] = [];

function profilesQuery() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: async () => ({ data: { display_name: "Arta Test", role: "author" }, error: null }),
  };
  return chain;
}

function staffQuery() {
  const q = { select: "", filters: [] as [string, unknown][] };
  staffQueries.push(q);
  const chain = {
    select: (cols: string) => {
      q.select = cols;
      return chain;
    },
    eq: (col: string, value: unknown) => {
      q.filters.push([col, value]);
      return chain;
    },
    maybeSingle: async () => staffRead,
  };
  return chain;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => (table === "staff_members" ? staffQuery() : profilesQuery()),
  }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/recovery-session", () => ({ isRecoverySessionActive: () => recovery }));
vi.mock("@/app/(public)/auth/actions", () => ({ logout: vi.fn() }));
vi.mock("@/components/nav-links", () => ({ NavLinks: () => null }));
vi.mock("@/components/mobile-nav", () => ({ MobileNav: () => null }));
vi.mock("@/components/feedback-button", () => ({ FeedbackButton: () => null }));

const { SiteHeader } = await import("./site-header");

async function render(): Promise<string> {
  return renderToStaticMarkup((await SiteHeader()) as ReactElement);
}

const BAR = 'aria-label="Stafi"';

describe("SiteHeader staff bar", () => {
  beforeEach(() => {
    user = { id: "user-1", email: "arta@example.test" };
    staffRead = { data: null, error: null };
    recovery = false;
    staffQueries.length = 0;
  });

  it("signed out: no bar and no staff read", async () => {
    user = null;
    const html = await render();
    expect(html).not.toContain(BAR);
    expect(staffQueries).toHaveLength(0);
  });

  it("signed in without a staff row: no bar; reads only the person's own row", async () => {
    const html = await render();
    expect(html).not.toContain(BAR);
    expect(staffQueries).toEqual([{ select: "role", filters: [["user_id", "user-1"]] }]);
  });

  it("a failed staff read shows no bar", async () => {
    staffRead = { data: null, error: { message: "boom" } };
    expect(await render()).not.toContain(BAR);
  });

  it("owner, admin, editor: Administrimi and + Postim i ri, same tab, above the header content", async () => {
    for (const role of ["owner", "admin", "editor"]) {
      staffRead = { data: { role }, error: null };
      const html = await render();
      expect(html, role).toContain(BAR);
      expect(html, role).toMatch(/<a [^>]*href="\/admin"[^>]*>Administrimi<\/a>/);
      expect(html, role).toMatch(/<a [^>]*href="\/admin\/blog\/new"[^>]*>\+ Postim i ri<\/a>/);
      expect(html, role).not.toMatch(/<nav aria-label="Stafi"[\s\S]*?target=[\s\S]*?<\/nav>/);
      expect(html.indexOf(BAR), role).toBeLessThan(html.indexOf('aria-label="Kryesore"'));
    }
  });

  it("moderator, support: Administrimi only", async () => {
    for (const role of ["moderator", "support"]) {
      staffRead = { data: { role }, error: null };
      const html = await render();
      expect(html, role).toContain(">Administrimi<");
      expect(html, role).not.toContain("Postim i ri");
    }
  });

  it("never during a password-recovery session", async () => {
    staffRead = { data: { role: "owner" }, error: null };
    recovery = true;
    expect(await render()).not.toContain(BAR);
  });
});
