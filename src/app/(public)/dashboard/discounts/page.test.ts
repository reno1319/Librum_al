import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// APP A EXHAUSTIVE AUDIT: this page renders discount_codes.
// amount_off_cents (found by the exhaustive schema-sensitive route
// audit, not listed in V3 §3's own inventory) -- this file exists
// solely to prove the maintenance gate at runtime.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("./actions", () => ({
  createDiscountCode: vi.fn(), toggleDiscountCode: vi.fn(), deleteDiscountCode: vi.fn(),
}));

const { default: DiscountsPage } = await import("./page");

function pageArgs() {
  return { searchParams: Promise.resolve({}) };
}

describe("DiscountsPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await DiscountsPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no discount amount or other configuration/identifier value", async () => {
    const element = await DiscountsPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(DiscountsPage(pageArgs())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// ALL-DISCOUNT-3: rendered coverage of the creation control and of
// every stored discount shape, with a stubbed Supabase client and
// renderToStaticMarkup -- the same approach as the book page's tests,
// no DOM dependency.
function queryStub(result: unknown) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(result);
        return () => chain;
      },
    },
  );
  return chain;
}

type DiscountValues = { percent_off: number | null; amount_off_cents: number | null; amount_off_all: number | null };
const NONE: DiscountValues = { percent_off: null, amount_off_cents: null, amount_off_all: null };
function codeRow(id: string, code: string, values: Partial<DiscountValues>) {
  return {
    id, author_id: "author-1", book_id: "book-1", code, ...NONE, ...values,
    active: true, expires_at: null, created_at: "2026-09-23T10:00:00Z", books: { title: "Test Book" },
  };
}

async function renderWith(codes: unknown[], books: unknown[] = [{ id: "book-1", title: "Test Book" }]) {
  mockCreateClient.mockImplementation((() => ({
    auth: { getUser: async () => ({ data: { user: { id: "author-1" } } }) },
    from: (table: string) => queryStub({ data: table === "books" ? books : codes }),
  })) as never);
  const element = await DiscountsPage(pageArgs());
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

// One code's rendered list item, so assertions cannot leak across rows.
function rowFor(html: string, code: string) {
  const match = html.match(new RegExp(`<li[^>]*>(?:(?!</li>).)*?${code}(?:(?!</li>).)*</li>`, "s"));
  expect(match, `row for ${code}`).not.toBeNull();
  return match![0];
}

describe("DiscountsPage: ALL discount creation and display", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("the creation control offers percentage and ALL fixed discounts, with no USD label", async () => {
    const html = await renderWith([]);
    const form = html.match(/<form[\s\S]*?<\/form>/)![0];
    expect(form).toContain('<option value="percent" selected="">Percentage off</option>');
    expect(form).toContain('<option value="amount_all">Fixed amount off (ALL, lek)</option>');
    expect(form).not.toMatch(/USD|\$/);
    expect(form).not.toContain('value="amount"');
    // A text value field, so "250,00" is enterable; no float step.
    expect(form).toMatch(/<input type="text" inputMode="decimal"[^>]*name="value"\/>/);
    expect(form).not.toContain('step="0.01"');
    expect(form).toContain("from 1 to 100000 ALL");
    // The page description names lek, not dollars.
    expect(html).toContain("a fixed amount in lek (ALL) off");
    expect(html).not.toMatch(/\$\d/);
  });

  it("renders a new amount_off_all code accurately, without the catalog minimum", async () => {
    const html = await renderWith([
      codeRow("c1", "SMALL1", { amount_off_all: 1 }),
      codeRow("c2", "BIG2500", { amount_off_all: 2500 }),
    ]);
    const small = rowFor(html, "SMALL1");
    expect(small).toContain("1,00 ALL off");
    expect(small).not.toContain("99,00");
    expect(small).not.toMatch(/legacy/i);
    expect(rowFor(html, "BIG2500")).toContain("2.500,00 ALL off");
    // The bug this replaces: an amount_off_all row used to render "$0.00 off".
    expect(html).not.toContain("$0.00");
  });

  it("renders a percentage code accurately", async () => {
    const html = await renderWith([codeRow("c1", "PCT20", { percent_off: 20 })]);
    const row = rowFor(html, "PCT20");
    expect(row).toContain("20% off");
    expect(row).not.toMatch(/ALL off|USD|legacy/i);
  });

  it("marks a legacy amount_off_cents code as legacy USD and inapplicable, never as ALL", async () => {
    const html = await renderWith([codeRow("c1", "OLDUSD", { amount_off_cents: 500 })]);
    const row = rowFor(html, "OLDUSD");
    expect(row).toContain("USD 5.00 off");
    expect(row).toContain("Legacy USD discount: not applicable to ALL checkout");
    expect(row).not.toMatch(/\d[\d.,]*\s*ALL off/);
    expect(row).not.toContain("5,00 ALL");
    expect(row).not.toContain("500,00 ALL");
    // Existing enable/disable and delete controls are unchanged for it.
    expect(row).toContain("Disable");
    expect(row).toContain("Delete");
  });

  it("renders all three shapes side by side, each with its own label", async () => {
    const html = await renderWith([
      codeRow("c1", "PCTTEN", { percent_off: 10 }),
      codeRow("c2", "ALLTWO", { amount_off_all: 200 }),
      codeRow("c3", "USDTHREE", { amount_off_cents: 300 }),
    ]);
    expect(rowFor(html, "PCTTEN")).toContain("10% off");
    expect(rowFor(html, "ALLTWO")).toContain("200,00 ALL off");
    expect(rowFor(html, "USDTHREE")).toContain("USD 3.00 off");
    expect(html.match(/not applicable to ALL checkout/g)).toHaveLength(1);
  });
});
