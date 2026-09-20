import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate on this
// schema-sensitive public book detail page (V3 §3), covering both the
// page component and generateMetadata -- not a general audit of Book
// Detail's own purchase/review/series logic, which has no page-level
// test file today.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
// Annotated `(): unknown` rather than left to inference: a factory whose
// only statement throws infers `never`, which then rejects every real
// client the full-page render tests below hand it.
const mockCreateClient = vi.fn((): unknown => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
// A tripwire by default (the maintenance gate must reach nothing), but
// overridable: the full-page render below legitimately fires the
// book_views insert.
const mockCreateAdminClient = vi.fn((): unknown => { throw new Error("ADMIN_CLIENT_CALLED"); });
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
vi.mock("./actions", () => ({
  buyBook: vi.fn(), getFreeBook: vi.fn(), submitReview: vi.fn(),
  addToWishlist: vi.fn(), removeFromWishlist: vi.fn(),
}));

const { default: BookDetailPage, generateMetadata } = await import("./page");

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
function pageArgs(searchParams: Record<string, string> = {}) {
  return { params: Promise.resolve({ id: BOOK_ID }), searchParams: Promise.resolve(searchParams) };
}

describe("BookDetailPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await BookDetailPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no price, book id, or other configuration/identifier value", async () => {
    const element = await BookDetailPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toContain(BOOK_ID);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("generateMetadata returns {} and performs zero Supabase calls, same as its own draft/missing-book fallback", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: BOOK_ID }) });
    expect(metadata).toEqual({});
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(BookDetailPage(pageArgs())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalled();
  });
});

// ============================================================
// STALE-CHECKOUT-1: the held-quote conflict notice.
//
// This is the one surface in the repair that shows a reader an AMOUNT,
// so what it must never do is take that amount from the URL. buyBook
// redirects here with an intent ID only; the price is read back
// server-side under that id. These tests render the real page against a
// stubbed Supabase and assert both halves: the amount comes from the
// row, and a crafted or foreign id shows nothing at all.
// ============================================================
const BOOK_ROW = {
  id: BOOK_ID, title: "Test Book", price_cents: 799, author_id: "author",
  status: "published", cover_path: null, series_id: null, genre: null,
  description: null, language: null, created_at: "2026-09-01T00:00:00Z",
  profiles: { public_author_name: "An Author", bio: null, avatar_path: null },
};
const INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

// A chainable stub: every builder method returns the same object, and
// awaiting it resolves to the seeded result. `.single()`/`.maybeSingle()`
// switch it to the ROW result, because a page that asks for one row and
// a page that asks for a list hit the same table through the same
// builder and only that call distinguishes them.
function queryStub(listResult: unknown, rowResult?: unknown) {
  let single = false;
  const builder: Record<string, unknown> = {};
  const chain = new Proxy(builder, {
    get(_target, prop) {
      if (prop === "then") {
        const result = single && rowResult !== undefined ? rowResult : listResult;
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === "single" || prop === "maybeSingle") {
        return () => { single = true; return chain; };
      }
      return () => chain;
    },
  });
  return chain;
}

function stubSupabase(options: { user?: { id: string } | null; quoteRows?: unknown[] | null } = {}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "user_owns_book") return { data: false };
    if (name === "get_book_checkout_quote") return { data: options.quoteRows ?? null };
    return { data: null };
  });
  const client = {
    auth: { getUser: async () => ({ data: { user: options.user === undefined ? { id: "reader" } : options.user } }) },
    rpc,
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "books") {
        return queryStub({ data: [] }, { data: BOOK_ROW });
      }
      return queryStub({ data: [] }, { data: null });
    },
  };
  return { client, rpc };
}

describe("BookDetailPage: stale-checkout conflict notice", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockReset();
    mockCreateAdminClient.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  async function render(searchParams: Record<string, string>, options?: Parameters<typeof stubSupabase>[0]) {
    const { client, rpc } = stubSupabase(options);
    mockCreateClient.mockImplementation(() => client);
    mockCreateAdminClient.mockImplementation(() => ({ from: () => queryStub({ data: null }) }));
    const element = await BookDetailPage(pageArgs(searchParams));
    return { html: renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]), rpc };
  }

  const heldQuote = [{
    intent_id: INTENT_ID, price_cents_at_checkout: 499, currency: "ALL",
    discount_code_id: null, expires_at: "2026-09-15T10:30:00Z",
    provider_window_ends_at: "2026-09-15T10:30:00Z", quote_state: "unresolved_conflict",
  }];

  it("renders the frozen amount read back from the row, and says the new price is not applied", async () => {
    const { html, rpc } = await render({ checkout_conflict: INTENT_ID }, { quoteRows: heldQuote });
    expect(rpc).toHaveBeenCalledWith("get_book_checkout_quote", { p_intent_id: INTENT_ID, p_book_id: BOOK_ID });
    expect(html).toContain("already have a checkout in progress");
    // The FROZEN 4.99, not the book's current 7.99.
    expect(html).toContain("4.99 ALL");
    expect(html).toContain("not");
    expect(html).toContain("Continue that checkout");
  });

  it("puts the intent id in the resume form, and never an amount", async () => {
    const { html } = await render({ checkout_conflict: INTENT_ID }, { quoteRows: heldQuote });
    expect(html).toContain('name="resume_existing"');
    expect(html).toContain(`value="${INTENT_ID}"`);
    // No price field the reader (or anyone crafting a request) could edit.
    expect(html).not.toMatch(/name="(price|amount|price_cents|price_cents_at_checkout)"/);
  });

  it("never reads an amount from the query string", async () => {
    // A crafted link carrying a price is simply not a thing this page
    // looks at: the notice still shows the database's own amount.
    const { html } = await render(
      { checkout_conflict: INTENT_ID, price_cents_at_checkout: "1", amount: "1" },
      { quoteRows: heldQuote },
    );
    expect(html).toContain("4.99 ALL");
    expect(html).not.toContain("0.01");
  });

  it("renders nothing and makes no quote call for a non-UUID conflict parameter", async () => {
    const { html, rpc } = await render({ checkout_conflict: "../../etc/passwd" }, { quoteRows: heldQuote });
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    expect(html).not.toContain("already have a checkout in progress");
  });

  it("renders nothing when the RPC returns no row (a foreign or mismatched intent)", async () => {
    const { html } = await render({ checkout_conflict: INTENT_ID }, { quoteRows: [] });
    expect(html).not.toContain("already have a checkout in progress");
  });

  it.each(["fulfilled", "completed", "superseded", "expired", "not_conflicting"])(
    "renders no resume offer for a quote in state %s", async (quote_state) => {
    const { html } = await render(
      { checkout_conflict: INTENT_ID },
      { quoteRows: [{ ...heldQuote[0], quote_state }] },
    );
    expect(html).not.toContain("Continue that checkout");
  });

  it("makes no quote call at all for an anonymous visitor", async () => {
    const { rpc, html } = await render({ checkout_conflict: INTENT_ID }, { user: null, quoteRows: heldQuote });
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    expect(html).not.toContain("already have a checkout in progress");
  });

  it("renders the lapsed-quote notice and offers no resume", async () => {
    const { html } = await render({ checkout_expired: "1" });
    expect(html).toContain("lapsed before it could be resumed");
    expect(html).toContain("nothing was charged");
    expect(html).not.toContain("Continue that checkout");
  });
});
