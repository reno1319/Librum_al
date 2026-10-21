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

// PAID-CHECKOUT-SURFACE-1: the exact protected-staging deployment plus the
// exact checkout mode -- the only configuration in which
// canStartPaidCheckout() is true.
function openPaidCheckout() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://erhzpapqwyfjotliqdjo.supabase.co");
  vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_checkout_test");
}
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
// ALL-WIRING-2 CORRECTION: `price_all` is EXPLICIT here, and it is a
// valid paid whole-lek price. It used to be absent altogether, so every
// test below rendered a book whose catalog state was "unavailable" --
// and the held-quote assertions passed anyway, which is precisely the
// defect this correction fixes. A fixture that succeeds because a field
// was omitted is proving the wrong thing.
//
// The legacy `price_cents: 799` is deliberately kept and deliberately
// different from `price_all`, so a body that read the wrong column
// would render a visibly wrong price.
const BOOK_ROW = {
  id: BOOK_ID, title: "Test Book", price_cents: 799, price_all: 250, author_id: "author",
  status: "published", cover_path: null, series_id: null, genre: null,
  description: null, language: null, created_at: "2026-09-01T00:00:00Z",
  // PEN-NAMES-1: the book's pen name, embedded from public_pen_names.
  pen_name_id: "pen-an-author",
  pen: { id: "pen-an-author", name: "An Author", bio: null, avatar_path: null, links: [] },
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

function stubSupabase(
  options: {
    user?: { id: string } | null;
    quoteRows?: unknown[] | null;
    book?: Record<string, unknown>;
    owns?: boolean;
  } = {},
) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "user_owns_book") return { data: options.owns ?? false };
    if (name === "get_book_checkout_quote") return { data: options.quoteRows ?? null };
    return { data: null };
  });
  const client = {
    auth: { getUser: async () => ({ data: { user: options.user === undefined ? { id: "reader" } : options.user } }) },
    rpc,
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) => {
      if (table === "books") {
        return queryStub({ data: [] }, { data: options.book ?? BOOK_ROW });
      }
      return queryStub({ data: [] }, { data: null });
    },
  };
  return { client, rpc };
}

describe("BookDetailPage: stale-checkout conflict notice", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // PAID-CHECKOUT-SURFACE-1: these blocks are about what an OPEN paid
    // checkout offers, so they run under the exact controlled-staging
    // checkout configuration. The closed case has its own file.
    openPaidCheckout();
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
    expect(html).toContain("4,99 ALL");
    expect(html).not.toContain("4.99 ALL");
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
    expect(html).toContain("4,99 ALL");
    expect(html).not.toContain("4.99 ALL");
    expect(html).not.toContain("0.01");
    expect(html).not.toContain("0,01");
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

// ============================================================
// ALL-WIRING-2 CORRECTION (Codex finding 1): a book with no authored
// ALL price exposes NO checkout-resume surface.
//
// PurchasePanel already refused to render an acquisition control for
// such a book. The held-quote notice and the lapsed-checkout notice are
// rendered OUTSIDE that panel, and were not gated on the purchase state
// at all -- so an authenticated non-owner arriving at a null-priced book
// with a valid ?checkout_conflict=<uuid> was still shown a frozen
// amount, a resume form carrying a real intent id, and a "Continue that
// checkout" button. Every one of those is an acquisition surface on a
// book the storefront has declared unavailable.
//
// These are RENDERED assertions against the real Server Component, not
// structural ones: the page is executed and its HTML is inspected.
// ============================================================
describe("BookDetailPage: an unavailable book exposes no checkout-resume surface", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    // PAID-CHECKOUT-SURFACE-1: these blocks are about what an OPEN paid
    // checkout offers, so they run under the exact controlled-staging
    // checkout configuration. The closed case has its own file.
    openPaidCheckout();
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

  // Identical in every respect to the paid fixture EXCEPT price_all.
  // The legacy price_cents is left at a real 25000, so a body that fell
  // back to it would classify this book as perfectly purchasable.
  const UNPRICED_BOOK = { ...BOOK_ROW, price_all: null, price_cents: 25000 };

  // An otherwise entirely valid unresolved held quote: the right intent
  // id, the right state, a real frozen amount. Nothing about the QUOTE
  // is wrong -- only the book's price state, which is the whole point.
  const heldQuote = [{
    intent_id: INTENT_ID, price_cents_at_checkout: 499, currency: "ALL",
    discount_code_id: null, expires_at: "2026-09-15T10:30:00Z",
    provider_window_ends_at: "2026-09-15T10:30:00Z", quote_state: "unresolved_conflict",
  }];

  it("never calls get_book_checkout_quote for a null-priced book", async () => {
    const { rpc } = await render(
      { checkout_conflict: INTENT_ID },
      { book: UNPRICED_BOOK, quoteRows: heldQuote },
    );
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
  });

  it("renders Price unavailable and none of the held-quote surface", async () => {
    const { html } = await render(
      { checkout_conflict: INTENT_ID },
      { book: UNPRICED_BOOK, quoteRows: heldQuote },
    );

    expect(html).toContain("Price unavailable");

    // The notice, the frozen amount, the form, its hidden fields and the
    // button -- each asserted individually, so a partial regression
    // cannot hide behind one surviving check.
    expect(html).not.toContain("already have a checkout in progress");
    expect(html).not.toContain("4.99 ALL");
    expect(html).not.toContain('name="resume_existing"');
    expect(html).not.toContain('name="expected_intent_id"');
    expect(html).not.toContain(INTENT_ID);
    expect(html).not.toContain("Continue that checkout");
    // No copy inviting the reader to start or resume a checkout.
    expect(html).not.toMatch(/start a new one|finish that checkout/i);
  });

  it("renders no buy form and no free-acquisition form", async () => {
    const { html } = await render(
      { checkout_conflict: INTENT_ID },
      { book: UNPRICED_BOOK, quoteRows: heldQuote },
    );

    expect(html).not.toContain("Buy ebook");
    expect(html).not.toContain("Get ebook");
    expect(html).not.toContain('placeholder="Promo code (optional)"');
    expect(html).not.toContain('name="code"');
    expect(html).not.toContain("Log in to buy");
    expect(html).not.toContain("Log in to get this book");
    // What it DOES show: the unavailable state, and the two things that
    // remain legitimate -- saving it for later, and the sample.
    expect(html).toContain("Not available right now");
  });

  it("checkout_expired=1 on a null-priced book shows no lapsed-checkout invitation", async () => {
    const { html } = await render(
      { checkout_expired: "1" },
      { book: UNPRICED_BOOK },
    );

    expect(html).toContain("Price unavailable");
    expect(html).not.toContain("lapsed before it could be resumed");
    // The specific false sentence: a null-priced book has no current
    // purchasable price to start a new checkout at.
    expect(html).not.toContain("You can start a new one at the current price");
    expect(html).not.toContain("start a new one at the current price");
    expect(html).not.toContain("Buy ebook");
    expect(html).not.toContain("Get ebook");
    expect(html).not.toContain('placeholder="Promo code (optional)"');
  });

  // The gate is the PURCHASE STATE, not merely "is price_all null" --
  // so the states that also have no paid checkout of their own are
  // covered too, and by the same one condition.
  it("an anonymous visitor to a null-priced book sees neither surface", async () => {
    const { html, rpc } = await render(
      { checkout_conflict: INTENT_ID },
      { book: UNPRICED_BOOK, user: null, quoteRows: heldQuote },
    );
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    expect(html).toContain("Price unavailable");
    expect(html).not.toContain("Continue that checkout");
    expect(html).not.toContain("Log in to buy");
  });

  it("a FREE book exposes no paid-checkout resume surface either", async () => {
    const { html, rpc } = await render(
      { checkout_conflict: INTENT_ID },
      { book: { ...BOOK_ROW, price_all: 0 }, quoteRows: heldQuote },
    );
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    expect(html).not.toContain("already have a checkout in progress");
    expect(html).not.toContain("Continue that checkout");
    // ...while its own legitimate free acquisition is untouched.
    expect(html).toContain("Get ebook — Free");
  });

  // Positive control, in this same block, so the two live side by side:
  // the SAME held quote on a properly priced book still produces the
  // full legitimate experience. Without this, every assertion above
  // could be satisfied by a page that renders nothing at all.
  it("the same held quote on a PAID, unowned book still renders the full resume experience", async () => {
    const { html, rpc } = await render(
      { checkout_conflict: INTENT_ID },
      { book: BOOK_ROW, quoteRows: heldQuote },
    );

    expect(rpc).toHaveBeenCalledWith("get_book_checkout_quote", {
      p_intent_id: INTENT_ID,
      p_book_id: BOOK_ID,
    });
    expect(html).toContain("already have a checkout in progress");
    // The server-read FROZEN amount (4.99 ALL), not the book's own
    // current catalog price (250 lek).
    expect(html).toContain("4,99 ALL");
    expect(html).not.toContain("4.99 ALL");
    expect(html).not.toContain("250 ALL</strong>. That is the amount");
    expect(html).toContain('name="resume_existing"');
    expect(html).toContain('name="expected_intent_id"');
    expect(html).toContain(`value="${INTENT_ID}"`);
    expect(html).toContain("Continue that checkout");
    // Only the intent id travels: never a client-supplied amount.
    expect(html).not.toMatch(/name="(price|amount|price_cents|price_cents_at_checkout)"/);
  });

  it("checkout_expired=1 on a PAID, unowned book still shows the lapsed notice", async () => {
    const { html } = await render({ checkout_expired: "1" }, { book: BOOK_ROW });
    expect(html).toContain("lapsed before it could be resumed");
    expect(html).toContain("nothing was charged");
    expect(html).not.toContain("Continue that checkout");
  });
});

// QA-FIX-2: POK's failRedirectUrl lands here with ?canceled=true.
describe("BookDetailPage: cancelled POK payment notice", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    openPaidCheckout();
    mockCreateClient.mockReset();
    mockCreateAdminClient.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  async function render(searchParams: Record<string, string>, options?: Parameters<typeof stubSupabase>[0]) {
    const { client } = stubSupabase(options);
    mockCreateClient.mockImplementation(() => client);
    mockCreateAdminClient.mockImplementation(() => ({ from: () => queryStub({ data: null }) }));
    const element = await BookDetailPage(pageArgs(searchParams));
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  const NOTICE = "Payment was cancelled or did not go through.";

  it("shows the notice on an unowned book", async () => {
    expect(await render({ canceled: "true" })).toContain(NOTICE);
  });

  it("shows nothing without the parameter or with another value", async () => {
    expect(await render({})).not.toContain(NOTICE);
    expect(await render({ canceled: "1" })).not.toContain(NOTICE);
  });

  it("shows nothing once the reader owns the book", async () => {
    expect(await render({ canceled: "true" }, { owns: true })).not.toContain(NOTICE);
  });
});

// ============================================================
// REDESIGN STEP 3: the A2 book page -- the price card's paid-book lines
// (Renato D4), the breadcrumb, and the Follow button in About the
// Author (B5), which reuses the author page's follow state and actions.
// ============================================================
describe("BookDetailPage: redesign step 3", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    openPaidCheckout();
    mockCreateClient.mockReset();
    mockCreateAdminClient.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  async function render(options: { user: { id: string } | null; following?: boolean; book?: Record<string, unknown> }) {
    const client = {
      auth: { getUser: async () => ({ data: { user: options.user } }) },
      rpc: vi.fn(async () => ({ data: false })),
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
      from: (table: string) => {
        if (table === "books") return queryStub({ data: [] }, { data: options.book ?? BOOK_ROW });
        if (table === "pen_name_follows") {
          return queryStub({ data: [] }, { data: options.following ? { pen_name_id: "pen-an-author" } : null });
        }
        return queryStub({ data: [] }, { data: null });
      },
    };
    mockCreateClient.mockImplementation(() => client);
    mockCreateAdminClient.mockImplementation(() => ({ from: () => queryStub({ data: null }) }));
    const element = await BookDetailPage(pageArgs());
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("a paid book's price card carries the mockup's three lines and the existing security note", async () => {
    const html = await render({ user: { id: "reader" } });
    expect(html).toContain("Buy ebook — 250 ALL");
    expect(html).toContain("EPUB, no DRM. Read on your phone, tablet or e-reader.");
    expect(html).toContain("Download anytime from your Librum library.");
    expect(html).toContain("Pay by card.");
    expect(html).not.toContain("POK app");
    expect(html).toMatch(/Secure checkout( with POK)?\./);
    expect(html).not.toContain("DRM-free EPUB. Download it anytime from your Librum Library.");
  });

  it("a free book keeps its existing sentence and none of the paid lines", async () => {
    const html = await render({ user: { id: "reader" }, book: { ...BOOK_ROW, price_all: 0 } });
    expect(html).toContain("Get ebook — Free");
    expect(html).toContain("Free — no payment required.");
    expect(html).not.toContain("Pay by card.");
  });

  it("the breadcrumb links the bookstore and the book's genre", async () => {
    const html = await render({ user: null, book: { ...BOOK_ROW, genre: "Poetry" } });
    expect(html).toContain('aria-label="Breadcrumb"');
    expect(html).toContain('href="/bookstore?genre=Poetry"');
  });

  // FIX1 (X4): no star row until the first review.
  it("shows no stars and no '0 out of 5 stars' before the first review, and keeps the words", async () => {
    const html = await render({ user: null });
    expect(html).toContain("No reviews yet");
    expect(html).not.toContain("out of 5 stars");
    expect(html).not.toContain("★");
  });

  // FIX1 (X14): a book with no cover gets the green placeholder with its
  // title and author, not a blank block.
  it("draws the cover placeholder with the title and author when there is no cover", async () => {
    const html = await render({ user: null });
    expect(html).toMatch(/aria-hidden="true" class="[^"]*bg-primary[^"]*"><div class="@container[^"]*"><div[^>]*><span[^>]*>Test Book<\/span><span[^>]*>An Author<\/span>/);
  });

  it("About the Author offers Follow to a signed-in reader, Following once followed", async () => {
    expect(await render({ user: { id: "reader" } })).toMatch(/>Follow<\/button>/);
    expect(await render({ user: { id: "reader" }, following: true })).toMatch(/>Following<\/button>/);
  });

  it("a visitor gets the author page's own Log in to follow link; the author gets no follow control", async () => {
    const anon = await render({ user: null });
    expect(anon).toContain("Log in to follow");
    expect(anon).toContain('href="/login?next=/authors/pen-an-author"');
    const author = await render({ user: { id: "author" } });
    expect(author).not.toContain("Follow");
  });
});
