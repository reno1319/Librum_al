import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// PEOPLE-1: the People list and a person's page. Their own gate
// (people.view), the RPC calls the list makes on the staff member's own
// session (never the service-role client for the list), the rendered
// columns, the error state, and the person page's 404s and sections.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
class NotFoundSignal extends Error {}

const mockRequireStaff = vi.fn((permission: string): Promise<{ userId: string; role: string }> => {
  void permission;
  return Promise.resolve({ userId: "staff-1", role: "admin" });
});
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NOT_FOUND");
  },
}));

type RpcResult = { data: unknown; error: { message: string } | null };
let rpcResult: (args: Record<string, unknown>) => RpcResult = () => ({ data: [], error: null });
let staffNamesResult: RpcResult = { data: [], error: null };
const rpcCalls: { fn: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (fn: string, args: Record<string, unknown>) => {
        rpcCalls.push({ fn, args });
        if (fn === "staff_profile_display_names") return Promise.resolve(staffNamesResult);
        return Promise.resolve(rpcResult(args));
      },
    }),
}));

// PEOPLE-2: the page passes the actions to the panel; they are tested
// in [id]/actions.test.ts.
vi.mock("./[id]/actions", () => ({
  suspendAccountAsStaff: async () => {},
  liftSuspensionAsStaff: async () => {},
  retryAccountAccessAsStaff: async () => {},
}));

let tables: Record<string, { data: unknown; error: { message: string } | null }> = {};
const adminTables: string[] = [];
let authUserResult: { data: { user: { banned_until?: string } | null }; error: { code?: string } | null } = {
  data: { user: {} },
  error: null,
};
const authUserReads: string[] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        getUserById: (id: string) => {
          authUserReads.push(id);
          return Promise.resolve(authUserResult);
        },
      },
    },
    from: (table: string) => {
      adminTables.push(table);
      const chain: Record<string, unknown> = {};
      for (const op of ["select", "eq", "in", "is", "order", "limit"]) chain[op] = () => chain;
      chain.returns = () => Promise.resolve(tables[table] ?? { data: [], error: null });
      return chain;
    },
  }),
}));

const { default: AdminPeoplePage } = await import("./page");
const { default: AdminPersonPage } = await import("./[id]/page");

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BEN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function person(overrides: Record<string, unknown> = {}) {
  return {
    user_id: ANA,
    display_name: "Ana Hoxha",
    email: "ana@example.com",
    account_type: "author",
    is_staff: false,
    live_books: 4,
    in_review_books: 0,
    draft_books: 1,
    paid_sales: 63,
    owned_books: 2,
    has_bank_account: true,
    joined_at: "2026-09-28T10:00:00Z",
    suspended: false,
    total_count: 2,
    ...overrides,
  };
}

async function renderList(search: Record<string, string> = {}): Promise<string> {
  const element = await AdminPeoplePage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element as ReactElement);
}

async function renderPerson(id: string, search: { error?: string; success?: string } = {}): Promise<string> {
  const element = await AdminPersonPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element as ReactElement);
}

beforeEach(() => {
  mockRequireStaff.mockClear();
  mockRequireStaff.mockImplementation(() => Promise.resolve({ userId: "staff-1", role: "admin" }));
  rpcCalls.length = 0;
  adminTables.length = 0;
  tables = {};
  authUserResult = { data: { user: {} }, error: null };
  authUserReads.length = 0;
  staffNamesResult = { data: [], error: null };
  rpcResult = (args) => {
    if (args.p_kind === "authors") return { data: [person({ total_count: 38 })], error: null };
    if (args.p_kind === "readers") return { data: [person({ total_count: 412 })], error: null };
    return {
      data: [
        person(),
        person({
          user_id: BEN,
          display_name: "Ben Reader",
          email: "ben@example.com",
          account_type: "reader",
          live_books: 0,
          draft_books: 0,
          paid_sales: 0,
          has_bank_account: false,
          suspended: true,
        }),
      ],
      error: null,
    };
  };
});

describe("/admin/people", () => {
  it("is gated on people.view and stops at the gate", async () => {
    mockRequireStaff.mockImplementation(() => Promise.reject(new RedirectSignal("/admin")));
    await expect(renderList()).rejects.toThrow("REDIRECT:/admin");
    expect(mockRequireStaff).toHaveBeenCalledWith("people.view");
    expect(rpcCalls).toHaveLength(0);
  });

  it("calls admin_list_people on the staff session with the parsed search, kind and page", async () => {
    await renderList({ q: "  hoxha ", show: "authors", page: "3" });
    const list = rpcCalls.find((c) => c.args.p_query !== undefined);
    expect(list).toEqual({
      fn: "admin_list_people",
      args: { p_query: "hoxha", p_kind: "authors", p_limit: 50, p_offset: 100 },
    });
    expect(rpcCalls.every((c) => c.fn === "admin_list_people")).toBe(true);
    expect(adminTables).toHaveLength(0);
  });

  it("an empty search is sent as null, an unknown kind as everyone", async () => {
    await renderList({ q: "   ", show: "staff" });
    expect(rpcCalls.find((c) => c.args.p_query !== undefined)?.args).toMatchObject({ p_query: null, p_kind: "everyone", p_offset: 0 });
  });

  it("renders the mockup's columns, the counts and each person's link", async () => {
    const html = await renderList();
    expect(html).toContain("38 authors · 412 readers");
    expect(html).toContain("2 people");
    for (const heading of ["Name", "Type", "Books", "Sales", "Bank account", "Joined", "Status"]) {
      expect(html).toContain(`>${heading}</th>`);
    }
    expect(html).toContain(`href="/admin/people/${ANA}"`);
    expect(html).toContain("ana@example.com");
    expect(html).toContain("4 live");
    expect(html).toContain(">63<");
    expect(html).toContain("Added");
    expect(html).toContain("Suspended");
    expect(html).toContain("Active");
    // Phones get stacked cards from the same rows; the table is desktop-only.
    expect(html).toContain('class="hidden overflow-x-auto md:block"');
    expect(html).toContain('<ul class="md:hidden">');
    expect(html.split(`href="/admin/people/${ANA}"`)).toHaveLength(4);
    expect(html).toContain("Author · Books 4 live · Sales 63 · Bank added · Joined");
    expect(html).toContain(">Reader · Joined");
    // Suspend lives on the person's page, not on the list.
    expect(html).not.toContain("Suspend account");
  });

  it("says so when the read fails", async () => {
    rpcResult = () => ({ data: null, error: { message: "boom" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await renderList();
    expect(html).toContain("Couldn&#x27;t load the people. Please try again.");
    errorSpy.mockRestore();
  });

  it("shows 'No one matches.' for an empty result", async () => {
    rpcResult = (args) => (args.p_query !== undefined ? { data: [], error: null } : { data: [person()], error: null });
    expect(await renderList({ q: "nobody" })).toContain("No one matches.");
  });
});

describe("/admin/people/[id]", () => {
  it("is gated on people.view", async () => {
    mockRequireStaff.mockImplementation(() => Promise.reject(new RedirectSignal("/admin")));
    await expect(renderPerson(ANA)).rejects.toThrow("REDIRECT:/admin");
    expect(mockRequireStaff).toHaveBeenCalledWith("people.view");
  });

  it("404s on a malformed id without reading anything", async () => {
    await expect(renderPerson("not-a-uuid")).rejects.toBeInstanceOf(NotFoundSignal);
    expect(rpcCalls).toHaveLength(0);
  });

  it("404s on an unknown account", async () => {
    rpcResult = () => ({ data: [], error: null });
    await expect(renderPerson(ANA)).rejects.toBeInstanceOf(NotFoundSignal);
    expect(rpcCalls[0]).toEqual({ fn: "admin_list_people", args: { p_user_id: ANA, p_limit: 1 } });
  });

  it("shows the account, pen names, books and suspension history with the reason", async () => {
    rpcResult = () => ({ data: [person({ suspended: true })], error: null });
    tables = {
      pen_names: { data: [{ id: "p1", name: "Ana H.", is_default: true }], error: null },
      books: { data: [{ id: "b1", title: "Deti", status: "draft", pen: { name: "Ana H." } }], error: null },
      account_suspensions: {
        data: [
          {
            id: "s1",
            reason: "Spam books",
            book_ids: ["b1"],
            bundle_ids: [],
            suspended_by: "staff-1",
            suspended_at: "2026-10-23T08:00:00Z",
            lifted_at: null,
            lifted_by: null,
          },
        ],
        error: null,
      },
      book_reviews: { data: [{ book_id: "b1" }], error: null },
      book_takedowns: { data: [], error: null },
    };
    staffNamesResult = { data: [{ id: "staff-1", display_name: "Renato" }], error: null };
    const html = await renderPerson(ANA);
    expect(html).toContain("Ana Hoxha");
    expect(html).toContain("ana@example.com");
    expect(html).toContain("Author · Suspended");
    expect(html).toContain("Ana H.");
    expect(html).toContain('href="/admin/books/b1"');
    expect(html).toContain("In review");
    expect(html).toContain("by Renato");
    expect(html).toContain("Reason: Spam books");
    expect(html).toContain("Took 1 book out of the Bookstore");
    expect(html).toContain("Still suspended");
    expect(rpcCalls.find((c) => c.fn === "staff_profile_display_names")?.args).toEqual({ p_ids: ["staff-1"] });
    expect(adminTables).not.toContain("profiles");
  });

  it("tells staff that a staff account can't be suspended", async () => {
    rpcResult = () => ({ data: [person({ is_staff: true, account_type: "reader" })], error: null });
    const html = await renderPerson(ANA);
    expect(html).toContain("This is a staff account.");
    expect(html).toContain("Never suspended.");
  });

  it("shows an error, not a blank page, when a detail read fails", async () => {
    rpcResult = () => ({ data: [person()], error: null });
    tables = { books: { data: null, error: { message: "boom" } } };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await renderPerson(ANA);
    expect(html).toContain("Couldn&#x27;t load everything about this person.");
    errorSpy.mockRestore();
  });

  describe("the Suspend / Lift panel (PEOPLE-2)", () => {
    const ACTIVE_ROW = {
      id: "s1",
      reason: "Spam books",
      book_ids: [],
      bundle_ids: [],
      suspended_by: "staff-1",
      suspended_at: "2026-10-23T08:00:00Z",
      lifted_at: null,
      lifted_by: null,
    };
    const FUTURE = "2126-10-23T08:00:00Z";

    it("offers Suspend with a required reason (up to 2000) and a red button to people.manage holders", async () => {
      rpcResult = () => ({ data: [person()], error: null });
      const html = await renderPerson(ANA);
      expect(html).toContain("Suspend account</summary>");
      expect(html).toContain('name="reason"');
      expect(html).toMatch(/<textarea[^>]*required=""/);
      expect(html).toContain('maxLength="2000"');
      expect(html).toContain(`name="userId" value="${ANA}"`);
      expect(html).toContain("bg-[#8E2A1E]");
      expect(html).toContain("It doesn&#x27;t include the reason.");
      expect(html).not.toContain("Lift suspension");
      expect(html).not.toContain("Try again");
      expect(authUserReads).toEqual([ANA]);
    });

    it("offers Lift, with one more click, on a suspended account", async () => {
      rpcResult = () => ({ data: [person({ suspended: true })], error: null });
      tables = { account_suspensions: { data: [ACTIVE_ROW], error: null } };
      authUserResult = { data: { user: { banned_until: FUTURE } }, error: null };
      const html = await renderPerson(ANA);
      expect(html).toContain("Lift suspension</summary>");
      expect(html).toContain("Yes, lift the suspension");
      expect(html).not.toContain("Suspend account</summary>");
      expect(html).not.toContain("Try again");
    });

    it("offers Try again when the row is active but sign-in is not blocked", async () => {
      rpcResult = () => ({ data: [person({ suspended: true })], error: null });
      tables = { account_suspensions: { data: [ACTIVE_ROW], error: null } };
      const html = await renderPerson(ANA);
      expect(html).toContain("Try again");
      expect(html).toContain("but it can still sign in");
    });

    it("offers Try again when no row is active but sign-in is still blocked", async () => {
      rpcResult = () => ({ data: [person()], error: null });
      tables = { account_suspensions: { data: [{ ...ACTIVE_ROW, lifted_at: "2026-10-23T09:00:00Z" }], error: null } };
      authUserResult = { data: { user: { banned_until: FUTURE } }, error: null };
      const html = await renderPerson(ANA);
      expect(html).toContain("Try again");
      expect(html).toContain("but it still can&#x27;t sign in");
      expect(html).toContain("Suspend account</summary>");
    });

    it("shows no Try again when the auth read fails", async () => {
      rpcResult = () => ({ data: [person({ suspended: true })], error: null });
      tables = { account_suspensions: { data: [ACTIVE_ROW], error: null } };
      authUserResult = { data: { user: null }, error: { code: "unexpected_failure" } };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const html = await renderPerson(ANA);
      expect(html).not.toContain("Try again");
      expect(html).toContain("Lift suspension</summary>");
      errorSpy.mockRestore();
    });

    it("hides the panel on a staff row, on the viewer's own row, and from people.view-only roles", async () => {
      rpcResult = () => ({ data: [person({ is_staff: true })], error: null });
      expect(await renderPerson(ANA)).not.toContain('id="person-suspension"');

      rpcResult = () => ({ data: [person()], error: null });
      mockRequireStaff.mockImplementation(() => Promise.resolve({ userId: ANA, role: "owner" }));
      expect(await renderPerson(ANA)).not.toContain('id="person-suspension"');

      mockRequireStaff.mockImplementation(() => Promise.resolve({ userId: "staff-1", role: "support" }));
      expect(await renderPerson(ANA)).not.toContain('id="person-suspension"');
      expect(authUserReads).toEqual([]);
    });

    it("hides the panel when the suspension history can't be read", async () => {
      rpcResult = () => ({ data: [person()], error: null });
      tables = { account_suspensions: { data: null, error: { message: "boom" } } };
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const html = await renderPerson(ANA);
      expect(html).not.toContain('id="person-suspension"');
      expect(html).toContain("Couldn&#x27;t load everything about this person.");
      errorSpy.mockRestore();
    });

    it("shows the action's success or error line", async () => {
      rpcResult = () => ({ data: [person()], error: null });
      expect(await renderPerson(ANA, { success: "Suspension lifted. They can sign in again." })).toContain(
        "Suspension lifted. They can sign in again.",
      );
      expect(await renderPerson(ANA, { error: "This account is already suspended." })).toContain(
        "This account is already suspended.",
      );
    });
  });
});
