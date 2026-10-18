import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// F5 (C1): the /admin/librum-choice page. requireStaff is mocked (same
// convention as blog/page.test.ts); the books table is an in-memory
// double that records the query the page builds.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw new Error("the page never creates a service-role client");
  },
}));
vi.mock("./actions", () => ({
  pickLibrumChoiceFromForm: async () => undefined,
  removeLibrumChoiceFromForm: async () => undefined,
}));

type Row = Record<string, unknown>;
let rows: Row[];
let listError: { code: string; message: string } | null;
let queries: { method: string; args: unknown[] }[][];
let clientsCreated: number;

function booksTable() {
  let result = [...rows];
  const calls: { method: string; args: unknown[] }[] = [];
  queries.push(calls);
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  const builder: Record<string, unknown> = {
    select: (...args: unknown[]) => (record("select", args), builder),
    eq: (col: string, value: unknown) => (record("eq", [col, value]), (result = result.filter((r) => r[col] === value)), builder),
    not: (col: string, op: string, value: unknown) => (record("not", [col, op, value]), (result = result.filter((r) => r[col] != null)), builder),
    in: (col: string, values: unknown[]) => (record("in", [col, values]), (result = result.filter((r) => values.includes(r[col]))), builder),
    ilike: (col: string, pattern: string) => {
      record("ilike", [col, pattern]);
      const needle = pattern.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      result = result.filter((r) => String(r[col]).toLowerCase().includes(needle));
      return builder;
    },
    order: (col: string, opts: unknown) =>
      (record("order", [col, opts]), (result = [...result].sort((a, b) => String(b[col]).localeCompare(String(a[col])))), builder),
    limit: (n: number) => (record("limit", [n]), (result = result.slice(0, n)), builder),
    returns: () => builder,
    maybeSingle: () => Promise.resolve({ data: result[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      resolve(listError && calls.some((c) => c.method === "limit") ? { data: null, error: listError } : { data: result, error: null }),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => {
    clientsCreated += 1;
    return Promise.resolve({
      from: () => booksTable(),
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
    });
  },
}));

const { default: Page } = await import("./page");

function book(n: number, extra: Row = {}): Row {
  const day = String(n).padStart(2, "0");
  return {
    id: `b${day}`, title: `Book ${day}`, status: "published", price_all: 199, cover_path: `c/${day}.png`,
    created_at: `2026-09-${day}T00:00:00Z`, pen_name: null, profiles: { public_author_name: "An Author" }, ...extra,
  };
}

async function render(params: Record<string, string> = {}) {
  const element = await Page({ searchParams: Promise.resolve(params) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const listQuery = () => queries.find((q) => q.some((c) => c.method === "limit"))!;

beforeEach(() => {
  rows = [book(1), book(2), book(3, { cover_path: null }), book(4, { price_all: null }), book(5, { status: "draft" })];
  listError = null;
  queries = [];
  clientsCreated = 0;
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "s1", role: "owner" });
});

describe("/admin/librum-choice", () => {
  it("a staff member without catalog.feature is redirected before any read", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/"));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(clientsCreated).toBe(0);
  });

  it("lists only published, priced books, newest first, first 21 asked", async () => {
    const html = await render();
    expect(listQuery()).toEqual([
      { method: "select", args: ["id, title, cover_path, profiles:public_author_profiles(public_author_name)"] },
      { method: "eq", args: ["status", "published"] },
      { method: "not", args: ["price_all", "is", null] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "limit", args: [21] },
    ]);
    expect(html).toContain("Book 01");
    expect(html).toContain("Book 03");
    expect(html).not.toContain("Book 04");
    expect(html).not.toContain("Book 05");
    expect(html.indexOf("Book 03")).toBeLessThan(html.indexOf("Book 01"));
    expect(html).not.toContain("Showing the first 20 books");
  });

  it("nothing picked: the sentence, and every row has Pick", async () => {
    const html = await render();
    expect(html).toContain("Nothing picked. The Bookstore shows the newest book as New on Librum.");
    expect(html.match(/>Pick</g)).toHaveLength(3);
    expect(html).not.toContain(">Remove<");
  });

  it("with a pick: the current pick with Remove, its row says Picked", async () => {
    rows[1] = book(2, { librum_choice_at: "2026-10-18T09:00:00Z", pen_name: "Pena" });
    const html = await render();
    expect(html).not.toContain("Nothing picked");
    expect(html).toContain(">Remove<");
    expect(html).toContain("Pena");
    expect(html.match(/>Picked</g)).toHaveLength(1);
    // F5 r2 (A2): "Picked" in the site's dark green token, never green-700.
    expect(html).toContain('<span class="text-sm font-semibold text-primary">Picked</span>');
    expect(html).not.toContain("green-700");
    expect(html.match(/>Pick</g)).toHaveLength(2);
  });

  // F5 r2 (A3): the current-pick card has a visible "Current pick" heading
  // that names its section, with and without a pick.
  it.each([false, true])("the current-pick card has a visible Current pick heading (picked: %s)", async (picked) => {
    if (picked) rows[0] = book(1, { librum_choice_at: "2026-10-18T09:00:00Z" });
    const html = await render();
    expect(html).toContain('<h2 id="librum-choice-current" class="mb-1 text-sm font-medium">Current pick</h2>');
    expect(html).toContain('aria-labelledby="librum-choice-current"');
    expect(html.indexOf("Current pick")).toBeLessThan(html.indexOf(picked ? ">Remove<" : "Nothing picked."));
  });

  it("a row without a cover says it is not on the homepage", async () => {
    const html = await render();
    expect(html.match(/Not on the homepage: no cover/g)).toHaveLength(1);
  });

  it("search: trimmed, % _ and \\ escaped, ilike on the title only", async () => {
    await render({ q: "  50%_off\\  " });
    expect(listQuery()).toContainEqual({ method: "ilike", args: ["title", "%50\\%\\_off\\\\%"] });
  });

  it("search with no match -> the no-match line", async () => {
    const html = await render({ q: "zzz" });
    expect(html).toContain("No published book matches your search.");
  });

  it("more than 20 books -> the first 20 and the line", async () => {
    rows = Array.from({ length: 25 }, (_, i) => book(i + 1));
    const html = await render();
    expect(html.match(/>Pick</g)).toHaveLength(20);
    expect(html).toContain("Showing the first 20 books");
  });

  it("a list-load error -> the existing generic sentence", async () => {
    listError = { code: "08006", message: "connection" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    expect(html).toContain("Something went wrong. Please try again.");
    expect(html).not.toContain(">Pick<");
    vi.restoreAllMocks();
  });

  it("success and error messages show", async () => {
    expect(await render({ success: "Saved." })).toContain("Saved.");
    expect(await render({ error: "That book can't be picked." })).toContain("That book can&#x27;t be picked.");
  });

  it("feature off (before the migration): Nothing picked, and the list still loads", async () => {
    // getLibrumChoiceBook's own read fails as feature-off; modelled by no
    // row carrying librum_choice_at, which is what the page sees (null).
    const html = await render();
    expect(html).toContain("Nothing picked.");
    expect(html).toContain(">Pick<");
  });
});
