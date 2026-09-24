import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

// PAID-CHECKOUT-SURFACE-1: the book detail page renders NO paid checkout
// initiation or resume surface while canStartPaidCheckout() is false.
//
// Every assertion here is made against the real Server Component's
// rendered HTML (renderToStaticMarkup over a stubbed Supabase client),
// not against the pure state function alone: a correct classifier is
// worthless if the page ignores it, and the three resume sites sit
// OUTSIDE the purchase panel.

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: () => ({ insert: async () => ({ data: null }) }) }),
}));
vi.mock("./actions", () => ({
  buyBook: vi.fn(), getFreeBook: vi.fn(), submitReview: vi.fn(),
  addToWishlist: vi.fn(), removeFromWishlist: vi.fn(),
}));

const { default: BookDetailPage } = await import("./page");
const { BookCard } = await import("@/components/book-card");

// Fixture Book U as it stands on staging: published, 199 ALL. The legacy
// price_cents is deliberately different so a body that read it would
// render a visibly wrong price.
const BOOK_U_ID = "00000000-f1c9-4000-8000-000000000002";
const AUTHOR_ID = "1f9d4948-0000-4000-8000-000000000000";
const READER_ID = "9229f938-0000-4000-8000-000000000000";
const BOOK_U = {
  id: BOOK_U_ID, title: "Fixture Book U", price_cents: 799, price_all: 199, author_id: AUTHOR_ID,
  status: "published", cover_path: null, series_id: null, genre: "Fiction",
  description: "About U.", language: null, created_at: "2026-09-01T00:00:00Z",
  published_at: "2026-09-02T00:00:00Z",
  profiles: { public_author_name: "Fixture Author", bio: null, avatar_path: null },
};
const INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HELD_QUOTE = [{
  intent_id: INTENT_ID, price_cents_at_checkout: 17910, currency: "ALL",
  discount_code_id: null, expires_at: "2026-09-15T10:30:00Z",
  provider_window_ends_at: "2026-09-15T10:30:00Z", quote_state: "unresolved_conflict",
}];
const NOTICE = "Buying this book isn&#x27;t available yet.";

function queryStub(listResult: unknown, rowResult?: unknown) {
  let single = false;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const result = single && rowResult !== undefined ? rowResult : listResult;
        return (resolve: (v: unknown) => unknown) => resolve(result);
      }
      if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
      return () => chain;
    },
  });
  return chain;
}

async function render(opts: {
  user: { id: string } | null;
  book?: Record<string, unknown>;
  owned?: boolean;
  searchParams?: Record<string, string>;
}) {
  const rpc = vi.fn(async (name: string) => {
    if (name === "user_owns_book") return { data: opts.owned ?? false };
    if (name === "get_book_checkout_quote") return { data: HELD_QUOTE };
    return { data: null };
  });
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: opts.user } }) },
    rpc,
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/x.png" } }) }) },
    from: (table: string) =>
      table === "books"
        ? queryStub({ data: [] }, { data: opts.book ?? BOOK_U })
        : queryStub({ data: [] }, { data: null }),
  }));
  const element = await BookDetailPage({
    params: Promise.resolve({ id: String((opts.book ?? BOOK_U).id) }),
    searchParams: Promise.resolve(
      opts.searchParams ?? { checkout_conflict: INTENT_ID, checkout_expired: "1" },
    ),
  });
  return { html: renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]), rpc };
}

function protectedStaging() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://erhzpapqwyfjotliqdjo.supabase.co");
}
function openPaidCheckout() {
  protectedStaging();
  vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_checkout_test");
}

// Every configuration in which canStartPaidCheckout() must be false.
const CLOSED: Array<[string, () => void]> = [
  ["no deployment markers and no mode", () => {
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("PAID_CHECKOUT_MODE", "");
  }],
  ["protected staging, mode absent", () => protectedStaging()],
  ["protected staging, mode empty", () => { protectedStaging(); vi.stubEnv("PAID_CHECKOUT_MODE", ""); }],
  ["protected staging, mode 'true'", () => { protectedStaging(); vi.stubEnv("PAID_CHECKOUT_MODE", "true"); }],
  ["protected staging, mode wrongly cased", () => {
    protectedStaging(); vi.stubEnv("PAID_CHECKOUT_MODE", "CONTROLLED_STAGING_CHECKOUT_TEST");
  }],
  ["protected staging, mode whitespace-padded", () => {
    protectedStaging(); vi.stubEnv("PAID_CHECKOUT_MODE", " controlled_staging_checkout_test");
  }],
  ["protected staging, the publishing mode's value", () => {
    protectedStaging(); vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_publishing_test");
  }],
  ["exact mode, Production environment", () => {
    openPaidCheckout(); vi.stubEnv("VERCEL_ENV", "production");
  }],
  ["exact mode, another branch", () => {
    openPaidCheckout(); vi.stubEnv("VERCEL_GIT_COMMIT_REF", "main");
  }],
  ["exact mode, another Supabase project", () => {
    openPaidCheckout(); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://pwkukotgpsegieshulpj.supabase.co");
  }],
];

/** Every paid checkout initiation or resume surface, asserted one by one. */
function expectNoPaidCheckoutSurface(html: string) {
  expect(html).not.toContain("Log in to buy");
  expect(html).not.toContain(`/login?next=/books/${BOOK_U_ID}`);
  expect(html).not.toContain('name="code"');
  expect(html).not.toContain("Promo code");
  expect(html).not.toContain("Buy ebook");
  expect(html).not.toContain('name="resume_existing"');
  expect(html).not.toContain('name="expected_intent_id"');
  expect(html).not.toContain(INTENT_ID);
  expect(html).not.toContain("Continue that checkout");
  expect(html).not.toContain("already have a checkout in progress");
  expect(html).not.toContain("lapsed before it could be resumed");
  expect(html).not.toContain("start a new one at the current price");
  // No claim that any checkout exists, and nothing about configuration.
  for (const claim of ["Secure checkout", "POK", "Stripe", "PAID_CHECKOUT_MODE", "controlled_staging", "NEXT_PUBLIC"]) {
    expect(html).not.toContain(claim);
  }
}
const countOf = (html: string, needle: string) => html.split(needle).length - 1;

beforeEach(() => {
  vi.unstubAllEnvs();
  mockCreateClient.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe.each(CLOSED)("paid checkout closed: %s", (_label, configure) => {
  beforeEach(configure);

  it("anonymous: the valid ALL price shows, 'Log in to buy' does not, and one neutral notice does", async () => {
    const { html, rpc } = await render({ user: null });
    expect(html).toContain("199,00 ALL");
    expectNoPaidCheckoutSurface(html);
    expect(countOf(html, NOTICE)).toBe(1);
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
  });

  it("signed-in reader: no promo, Buy, resume or expired-checkout surface, and no quote lookup", async () => {
    const { html, rpc } = await render({ user: { id: READER_ID } });
    expect(html).toContain("199,00 ALL");
    expectNoPaidCheckoutSurface(html);
    expect(countOf(html, NOTICE)).toBe(1);
    expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    // Wishlist and sample stay where they applied before.
    expect(html).toContain("Save for later");
    expect(html).toContain("Read sample");
  });
});

describe("paid checkout open: exact controlled-staging mode on protected staging", () => {
  beforeEach(openPaidCheckout);

  it("anonymous: 'Log in to buy' is restored and no unavailable notice shows", async () => {
    const { html } = await render({ user: null });
    expect(html).toContain("Log in to buy");
    expect(html).toContain(`/login?next=/books/${BOOK_U_ID}`);
    expect(html).not.toContain(NOTICE);
  });

  it("signed-in reader: promo, Buy, the held-quote resume and the lapsed notice are all restored", async () => {
    const { html, rpc } = await render({ user: { id: READER_ID } });
    expect(rpc).toHaveBeenCalledWith("get_book_checkout_quote", { p_intent_id: INTENT_ID, p_book_id: BOOK_U_ID });
    expect(html).toContain('name="code"');
    expect(html).toContain("Buy ebook — 199,00 ALL");
    expect(html).toContain("Continue that checkout");
    expect(html).toContain(`value="${INTENT_ID}"`);
    expect(html).toContain("179,10 ALL");
    expect(html).toContain("lapsed before it could be resumed");
    expect(html).not.toContain(NOTICE);
  });
});

describe("states that never had a paid checkout are unchanged, open or closed", () => {
  for (const [label, configure] of [
    ["closed", () => protectedStaging()],
    ["open", openPaidCheckout],
  ] as const) {
    it(`free book (${label}): free acquisition stays available and needs no paid mode`, async () => {
      configure();
      const free = { ...BOOK_U, price_all: 0 };
      const reader = await render({ user: { id: READER_ID }, book: free });
      expect(reader.html).toContain("Get ebook — Free");
      expect(reader.html).not.toContain(NOTICE);
      expect(reader.rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
      const anon = await render({ user: null, book: free });
      expect(anon.html).toContain("Log in to get this book");
      expect(anon.html).not.toContain(NOTICE);
    });

    it(`unpriced book (${label}): 'Not available right now', and not the checkout notice`, async () => {
      configure();
      const { html } = await render({ user: { id: READER_ID }, book: { ...BOOK_U, price_all: null } });
      expect(html).toContain("Not available right now");
      expect(html).not.toContain(NOTICE);
      expect(html).not.toContain("Buy ebook");
    });

    it(`author (${label}): Manage book, no checkout surface and no notice`, async () => {
      configure();
      const { html, rpc } = await render({ user: { id: AUTHOR_ID } });
      expect(html).toContain("Manage book");
      expect(html).toContain("199,00 ALL");
      expect(html).not.toContain(NOTICE);
      expect(html).not.toContain("Buy ebook");
      expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    });

    it(`owner (${label}): 'You own this book', no checkout surface and no notice`, async () => {
      configure();
      const { html, rpc } = await render({ user: { id: READER_ID }, owned: true });
      expect(html).toContain("You own this book");
      expect(html).not.toContain(NOTICE);
      expect(html).not.toContain("Buy ebook");
      expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
    });
  }
});

// ============================================================
// D. Fixture Book U, as staging should show it once this is deployed
// and while PAID_CHECKOUT_MODE is still absent.
// ============================================================
describe("Fixture Book U on staging with PAID_CHECKOUT_MODE absent", () => {
  beforeEach(protectedStaging);

  it("stays visible in discovery at 199,00 ALL", () => {
    const html = renderToStaticMarkup(
      createElement(BookCard, { book: BOOK_U, coverUrl: null, authorName: "Fixture Author" }),
    );
    expect(html).toContain("199,00 ALL");
    expect(html).toContain(`/books/${BOOK_U_ID}`);
    expect(html).not.toContain("Buy");
  });

  it("its author sees 199,00 ALL and Manage book", async () => {
    const { html } = await render({ user: { id: AUTHOR_ID }, searchParams: {} });
    expect(html).toContain("199,00 ALL");
    expect(html).toContain("Manage book");
  });

  it("anonymous and reader views: no login-to-buy, no Buy/promo/resume, no quote RPC, one neutral notice", async () => {
    for (const user of [null, { id: READER_ID }]) {
      const { html, rpc } = await render({ user });
      expectNoPaidCheckoutSurface(html);
      expect(countOf(html, NOTICE)).toBe(1);
      expect(rpc).not.toHaveBeenCalledWith("get_book_checkout_quote", expect.anything());
      // Still 199 ALL: nothing in rendering moves U back to free.
      expect(html).toContain("199,00 ALL");
      expect(html).not.toContain("Get ebook — Free");
    }
  });
});

// ============================================================
// E6. The three resume/expired-notice sites (the quote lookup, the
// held-quote form, the lapsed notice) stay governed by ONE named
// condition, and that condition is what the paid-mode gate closes.
// ============================================================
describe("one named condition governs every resume surface", () => {
  const source = readFileSync(fileURLToPath(new URL("./page.tsx", import.meta.url)), "utf8");
  const code = source.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");

  it("canResumePaidCheckout is defined once, from the purchase state, and used at exactly three sites", () => {
    expect(code.match(/const canResumePaidCheckout = purchaseState === "paid-unowned";/g)).toHaveLength(1);
    expect(code.match(/canResumePaidCheckout/g)).toHaveLength(4);
    expect(code).toMatch(/if \(conflictIntentId && user && canResumePaidCheckout\)/);
    expect(code).toMatch(/\{heldQuote && canResumePaidCheckout && \(/);
    expect(code).toMatch(/\{checkoutExpired === "1" && canResumePaidCheckout && \(/);
  });

  it("the quote RPC is called in one place only", () => {
    expect(code.match(/get_book_checkout_quote/g)).toHaveLength(1);
  });

  it("the purchase state is fed by the server-only capability, with no NEXT_PUBLIC path", () => {
    expect(code).toContain('import { canStartPaidCheckout } from "@/lib/paid-readiness";');
    expect(code).toContain("const paidCheckoutAvailable = canStartPaidCheckout();");
    expect(code).not.toContain("PAID_CHECKOUT_MODE");
    expect(code).not.toMatch(/NEXT_PUBLIC_[A-Z_]*PAID/);
  });
});
