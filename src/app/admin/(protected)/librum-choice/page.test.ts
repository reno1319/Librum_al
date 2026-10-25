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
  setHomeSlotFromForm: async () => undefined,
  removeHomeSlotFromForm: async () => undefined,
}));
// HOME-PICKS-1: the slot rows come from the gated service-role helper,
// modelled here; the slot books' titles are read from public_books
// through the same in-memory table as the list.
type SlotRow = { slot: number; book_id: string; sponsored: boolean };
let homeSlots: { ok: true; slots: SlotRow[] } | { ok: false };
vi.mock("@/lib/home-picks", () => ({ getHomeSlotsForStaff: () => Promise.resolve(homeSlots) }));

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
    created_at: `2026-09-${day}T00:00:00Z`, pen_name: null, pen: { id: "pen-an-author", name: "An Author" }, ...extra,
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
  homeSlots = { ok: true, slots: [] };
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
      { method: "select", args: ["id, title, cover_path, pen:public_pen_names(id, name)"] },
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
    rows[1] = book(2, { librum_choice_at: "2026-10-18T09:00:00Z", pen: { id: "pen-pena", name: "Pena" } });
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
    expect(html).toContain(
      '<h2 id="librum-choice-current" class="mb-1 text-sm font-medium">Librum&#x27;s choice on the Bookstore: current pick</h2>',
    );
    expect(html).toContain('aria-labelledby="librum-choice-current"');
    expect(html.indexOf("current pick</h2>")).toBeLessThan(html.indexOf(picked ? ">Remove<" : "Nothing picked."));
  });

  it("a row without a cover says it can't go on the home page", async () => {
    const html = await render();
    expect(html.match(/Can&#x27;t go on the home page: no cover/g)).toHaveLength(1);
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

describe("/admin/librum-choice: home page covers (HOME-PICKS-1)", () => {
  const slotCards = (html: string) => html.slice(html.indexOf('id="home-slots"'), html.indexOf('id="librum-choice-current"'));

  it("is titled Featured picks, with the home slots before Librum's choice", async () => {
    const html = await render();
    expect(html).toContain(">Featured picks</h1>");
    expect(html.indexOf("Home page covers")).toBeLessThan(html.indexOf("Librum&#x27;s choice on the Bookstore"));
  });

  it("no slots filled: three Empty slots, labelled by place in the fan", async () => {
    const cards = slotCards(await render());
    expect(cards.match(/Empty: the home page shows the newest book here\./g)).toHaveLength(3);
    for (const label of ["Slot 1 (middle, in front)", "Slot 2 (left)", "Slot 3 (right)"]) expect(cards).toContain(label);
  });

  it("a filled paid slot: the book with its byline, Paid ticked, Save and Remove", async () => {
    rows[1] = book(2, { pen: { id: "pen-pena", name: "Pena" } });
    homeSlots = { ok: true, slots: [{ slot: 1, book_id: "b02", sponsored: true }] };
    const cards = slotCards(await render());
    expect(cards).toContain("Book 02");
    expect(cards).toContain("Pena");
    expect(cards).toContain("Paid: shows Sponsored");
    expect(cards).toContain('<input type="checkbox" class="size-4" name="sponsored" checked=""/>');
    expect(cards).toContain('aria-label="Save Slot 1 (middle, in front)"');
    expect(cards).toContain('aria-label="Remove Slot 1 (middle, in front)"');
    expect(cards.match(/Empty:/g)).toHaveLength(2);
  });

  it("an unpaid slot: Paid not ticked, no Sponsored line", async () => {
    homeSlots = { ok: true, slots: [{ slot: 2, book_id: "b01", sponsored: false }] };
    const cards = slotCards(await render());
    expect(cards).toContain("Book 01");
    expect(cards).not.toContain("Paid: shows Sponsored");
    expect(cards).toContain('<input type="checkbox" class="size-4" name="sponsored"/>');
  });

  it("a slot whose book is not published now: marked, a link to the book, Remove only", async () => {
    homeSlots = { ok: true, slots: [{ slot: 3, book_id: "b05", sponsored: true }] };
    const cards = slotCards(await render());
    expect(cards).toContain("A book that is not published now");
    expect(cards).toContain("Not live now: the home page shows the newest book here.");
    expect(cards).toContain('href="/admin/books/b05"');
    expect(cards).not.toContain('aria-label="Save Slot 3 (right)"');
    expect(cards).toContain('aria-label="Remove Slot 3 (right)"');
  });

  it("a slot read error: the generic sentence instead of the slots, the list still loads", async () => {
    homeSlots = { ok: false };
    const html = await render();
    expect(slotCards(html)).toContain("Something went wrong. Please try again.");
    expect(slotCards(html)).not.toContain("Empty:");
    expect(html).toContain(">Pick<");
  });

  it("each listed book with a cover can be put on the home page; not one in a slot, nor one without a cover", async () => {
    homeSlots = { ok: true, slots: [{ slot: 2, book_id: "b01", sponsored: false }] };
    const html = await render();
    expect(html.match(/>Put on home page</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Put Book 02 on the home page"');
    expect(html).toContain("On the home page: slot 2");
    expect(html).not.toContain('aria-label="Put Book 03 on the home page"');
  });

  it("the put form offers the three slots and an unticked Paid box", async () => {
    const html = await render();
    const form = html.slice(html.indexOf('id="home-slot-b02"') - 200, html.indexOf('aria-label="Put Book 02 on the home page"'));
    expect(form.match(/<option value="[123]"/g)).toEqual(['<option value="1"', '<option value="2"', '<option value="3"']);
    expect(form).toContain('<input type="checkbox" class="size-4" name="sponsored"/>');
  });
});
