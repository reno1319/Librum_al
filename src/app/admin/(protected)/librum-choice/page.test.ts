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
// A page past the last one: PostgREST answers PGRST103.
let rangeError: boolean;
let queries: { method: string; args: unknown[] }[][];
let clientsCreated: number;

function booksTable() {
  let result = [...rows];
  let count = 0;
  let pastEnd = false;
  const calls: { method: string; args: unknown[] }[] = [];
  queries.push(calls);
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  const builder: Record<string, unknown> = {
    select: (...args: unknown[]) => (record("select", args), builder),
    eq: (col: string, value: unknown) => (record("eq", [col, value]), (result = result.filter((r) => r[col] === value)), builder),
    not: (col: string, op: string, value: unknown) => (record("not", [col, op, value]), (result = result.filter((r) => r[col] != null)), builder),
    in: (col: string, values: unknown[]) => (record("in", [col, values]), (result = result.filter((r) => values.includes(r[col]))), builder),
    filter: (col: string, op: string, value: string) => {
      record("filter", [col, op, value]);
      if (op !== "not.in") throw new Error(`unexpected filter ${op}`);
      const ids = value.slice(1, -1).split(",");
      result = result.filter((r) => !ids.includes(String(r[col])));
      return builder;
    },
    ilike: (col: string, pattern: string) => {
      record("ilike", [col, pattern]);
      const needle = pattern.slice(1, -1).replace(/\\(.)/g, "$1").toLowerCase();
      result = result.filter((r) => String(r[col]).toLowerCase().includes(needle));
      return builder;
    },
    // Only created_at is sorted for real (the id order just breaks ties).
    order: (col: string, opts: unknown) => (
      record("order", [col, opts]),
      col === "created_at" && (result = [...result].sort((a, b) => String(b[col]).localeCompare(String(a[col])))),
      builder
    ),
    limit: (n: number) => (record("limit", [n]), (result = result.slice(0, n)), builder),
    range: (from: number, to: number) => {
      record("range", [from, to]);
      const total = result.length;
      if (rangeError && from > 0 && from >= total) {
        result = [];
        pastEnd = true;
      } else result = result.slice(from, to + 1);
      count = total;
      return builder;
    },
    returns: () => builder,
    maybeSingle: () => Promise.resolve({ data: result[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => {
      const isList = calls.some((c) => c.method === "range");
      if (listError && isList) return resolve({ data: null, error: listError, count: null });
      if (pastEnd) return resolve({ data: null, error: { code: "PGRST103", message: "Requested range not satisfiable" }, count: null });
      return resolve({ data: result, error: null, count: isList ? count : null });
    },
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

const listQueries = () => queries.filter((q) => q.some((c) => c.method === "range"));
const listQuery = () => listQueries()[0];
const putButtons = (html: string) => [...html.matchAll(/aria-label="Put Book (\d+) on the home page"/g)].map((m) => m[1]);

beforeEach(() => {
  rows = [book(1), book(2), book(3, { cover_path: null }), book(4, { price_all: null }), book(5, { status: "draft" })];
  listError = null;
  rangeError = false;
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

  it("lists only published, priced books, newest first, the first 10 asked with a count", async () => {
    const html = await render();
    expect(listQuery()).toEqual([
      { method: "select", args: ["id, title, cover_path, original_author, pen:public_pen_names(id, name)", { count: "exact" }] },
      { method: "eq", args: ["status", "published"] },
      { method: "not", args: ["price_all", "is", null] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "order", args: ["id", { ascending: false }] },
      { method: "range", args: [0, 9] },
    ]);
    expect(html).toContain("Book 01");
    expect(html).toContain("Book 03");
    expect(html).not.toContain("Book 04");
    expect(html).not.toContain("Book 05");
    expect(html.indexOf("Book 03")).toBeLessThan(html.indexOf("Book 01"));
    expect(html).not.toContain("Showing the first 20 books");
    expect(html).not.toContain("Book list pages");
  });

  // LR1 patch 3 (lr3-6b a): the Librum's choice part is gone; the page
  // keeps the home page covers and the book search.
  it("has no Librum's choice part: no current pick, no Pick button, no pick read", async () => {
    rows[1] = book(2, { librum_choice_at: "2026-10-18T09:00:00Z" });
    const html = await render();
    expect(html).not.toContain("Librum&#x27;s choice");
    expect(html).not.toContain("Nothing picked");
    expect(html).not.toContain(">Pick<");
    expect(html).not.toContain(">Picked<");
    expect(queries.some((q) => q.some((c) => c.method === "not" && c.args[0] === "librum_choice_at"))).toBe(false);
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
    expect(html).not.toContain("All published books are already on the home page.");
  });

  it("10 books or fewer -> no pager", async () => {
    rows = Array.from({ length: 10 }, (_, i) => book(i + 1));
    const html = await render();
    expect(putButtons(html)).toHaveLength(10);
    expect(html).not.toContain("Book list pages");
    expect(html).not.toContain("Previous");
    expect(html).not.toContain("Next");
  });

  it("more than 10 books: page 1 shows the newest 10, Page 1 of N and Next only", async () => {
    rows = Array.from({ length: 23 }, (_, i) => book(i + 1));
    const html = await render();
    expect(putButtons(html)).toEqual(["23", "22", "21", "20", "19", "18", "17", "16", "15", "14"]);
    expect(html).toContain('aria-label="Book list pages"');
    expect(html).toContain("Page 1 of 3");
    expect(html).toContain('href="/admin/librum-choice?page=2"');
    expect(html).toContain("Next ›");
    expect(html).not.toContain("Previous");
    expect(html).not.toContain("Showing the first 20 books");
  });

  it("a middle page has Previous and Next; the last page Previous only", async () => {
    rows = Array.from({ length: 23 }, (_, i) => book(i + 1));
    const middle = await render({ page: "2" });
    expect(listQuery()).toContainEqual({ method: "range", args: [10, 19] });
    expect(putButtons(middle)).toEqual(["13", "12", "11", "10", "09", "08", "07", "06", "05", "04"]);
    expect(middle).toContain('href="/admin/librum-choice"');
    expect(middle).toContain("‹ Previous");
    expect(middle).toContain('href="/admin/librum-choice?page=3"');
    expect(middle).toContain("Page 2 of 3");
    queries = [];
    const last = await render({ page: "3" });
    expect(putButtons(last)).toEqual(["03", "02", "01"]);
    expect(last).toContain('href="/admin/librum-choice?page=2"');
    expect(last).toContain("‹ Previous");
    expect(last).not.toContain("Next");
    expect(last).toContain("Page 3 of 3");
  });

  it("the pager keeps the search", async () => {
    rows = Array.from({ length: 23 }, (_, i) => book(i + 1, { title: `Ura ${String(i + 1).padStart(2, "0")}` }));
    const html = await render({ q: "Ura", page: "2" });
    expect(html).toContain('href="/admin/librum-choice?q=Ura"');
    expect(html).toContain('href="/admin/librum-choice?q=Ura&amp;page=3"');
  });

  it("a page past the last one shows page 1, not an error", async () => {
    rows = Array.from({ length: 12 }, (_, i) => book(i + 1));
    rangeError = true;
    const html = await render({ page: "9" });
    expect(listQueries().map((q) => q.find((c) => c.method === "range")!.args)).toEqual([[80, 89], [0, 9]]);
    expect(html).not.toContain("Something went wrong");
    expect(putButtons(html)).toHaveLength(10);
    expect(html).toContain("Page 1 of 2");
  });

  it("a bad ?page is page 1", async () => {
    rows = Array.from({ length: 12 }, (_, i) => book(i + 1));
    await render({ page: "2abc" });
    expect(listQuery()).toContainEqual({ method: "range", args: [0, 9] });
  });

  it("a list-load error -> the existing generic sentence", async () => {
    listError = { code: "08006", message: "connection" };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    expect(html).toContain("Something went wrong. Please try again.");
    expect(html).not.toContain("on the home page\"");
    vi.restoreAllMocks();
  });

  it("success and error messages show", async () => {
    expect(await render({ success: "Saved." })).toContain("Saved.");
    expect(await render({ error: "That book can't go on the home page." })).toContain("That book can&#x27;t go on the home page.");
  });
});

describe("/admin/librum-choice: home page covers (HOME-PICKS-1)", () => {
  const slotCards = (html: string) => html.slice(html.indexOf('id="home-slots"'), html.indexOf('id="librum-choice-q"'));

  it("is titled Featured picks, with the home slots before the book search", async () => {
    const html = await render();
    expect(html).toContain(">Featured picks</h1>");
    expect(html.indexOf("Home page covers")).toBeLessThan(html.indexOf("Search published books"));
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
    expect(html).toContain("Book 01");
  });

  it("each listed book with a cover can be put on the home page; one without a cover can't", async () => {
    const html = await render();
    expect(html.match(/>Put on home page</g)).toHaveLength(2);
    expect(html).toContain('aria-label="Put Book 02 on the home page"');
    expect(html).toContain('aria-label="Put Book 01 on the home page"');
    expect(html).not.toContain('aria-label="Put Book 03 on the home page"');
  });

  // ff3 a (Renato 2026-11-26): the list leaves out the books in a slot.
  const SLOT_ID = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

  it("books already in a slot are left out of the list (search too), with no slot line", async () => {
    rows = [book(1, { id: SLOT_ID(1) }), book(2), book(6, { id: SLOT_ID(6) })];
    homeSlots = { ok: true, slots: [{ slot: 2, book_id: SLOT_ID(1), sponsored: false }, { slot: 1, book_id: SLOT_ID(6), sponsored: true }] };
    const html = await render({ q: "Book" });
    expect(listQuery()).toContainEqual({ method: "filter", args: ["id", "not.in", `(${SLOT_ID(1)},${SLOT_ID(6)})`] });
    expect(putButtons(html)).toEqual(["02"]);
    expect(html).not.toContain("On the home page: slot");
    // The slot cards still show both.
    expect(html.slice(html.indexOf('id="home-slots"'), html.indexOf('id="librum-choice-q"'))).toContain("Book 06");
  });

  it("only well-formed slot ids go into the filter", async () => {
    homeSlots = { ok: true, slots: [{ slot: 1, book_id: "b01),id.eq.(x", sponsored: false }] };
    await render();
    expect(listQuery().some((c) => c.method === "filter")).toBe(false);
  });

  it("every book in a slot and no search -> the all-on-the-home-page line", async () => {
    rows = [book(1, { id: SLOT_ID(1) }), book(2, { id: SLOT_ID(2) }), book(3, { id: SLOT_ID(3) })];
    homeSlots = {
      ok: true,
      slots: [1, 2, 3].map((n) => ({ slot: n, book_id: SLOT_ID(n), sponsored: false })),
    };
    const html = await render();
    expect(html).toContain("All published books are already on the home page.");
    expect(html).not.toContain("No published book matches your search.");
    expect(html).not.toContain("Book list pages");
  });

  it("the put form offers the three slots and an unticked Paid box", async () => {
    const html = await render();
    const form = html.slice(html.indexOf('id="home-slot-b02"') - 200, html.indexOf('aria-label="Put Book 02 on the home page"'));
    expect(form.match(/<option value="[123]"/g)).toEqual(['<option value="1"', '<option value="2"', '<option value="3"']);
    expect(form).toContain('<input type="checkbox" class="size-4" name="sponsored"/>');
  });
});
