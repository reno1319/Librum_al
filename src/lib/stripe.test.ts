import { afterEach, describe, expect, it, vi } from "vitest";

// PHASE-1C Preview-build correction: this suite exists because the
// original `export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)`
// constructed a real client at MODULE SCOPE -- so merely importing
// this file (which Next.js's build-time "Collecting page data" step
// does for every route, regardless of whether it's ever visited) threw
// whenever STRIPE_SECRET_KEY was absent, breaking the entire
// `next build`. getStripe() defers both the env read and the
// construction to the first real call, made from inside a request
// handler/Server Action -- never from module scope.
//
// vitest.config.mts sets a global dummy STRIPE_SECRET_KEY for the whole
// suite (other test files' real Supabase-guard-adjacent constructors
// need SOME value to be present at import time). Every test below that
// needs the "absent" case explicitly deletes/blanks it first and
// restores the original value afterward via afterEach -- never assumes
// the ambient default. `vi.resetModules()` before each dynamic
// `import("./stripe")` guarantees a fresh module instance (and thus a
// fresh, unmemoized `cachedClient`), so one test's state can never leak
// into another's.
//
// No real credential and no network call anywhere in this file: the
// Stripe SDK's own constructor never makes a network request (it just
// stores config) -- only calling an actual resource method like
// `.checkout.sessions.create()` would, and nothing here ever does
// that. The "configured" tests below use an obviously fake,
// locally-invented string, not a real key.
describe("src/lib/stripe.ts: getStripe()", () => {
  const ORIGINAL_STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    if (ORIGINAL_STRIPE_SECRET_KEY === undefined) {
      delete process.env.STRIPE_SECRET_KEY;
    } else {
      process.env.STRIPE_SECRET_KEY = ORIGINAL_STRIPE_SECRET_KEY;
    }
    vi.resetModules();
  });

  it("importing the module with STRIPE_SECRET_KEY absent does not throw", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();

    await expect(import("./stripe")).resolves.toBeDefined();
  });

  it("importing the module with STRIPE_SECRET_KEY blank does not throw", async () => {
    process.env.STRIPE_SECRET_KEY = "   ";
    vi.resetModules();

    await expect(import("./stripe")).resolves.toBeDefined();
  });

  it("calling getStripe() with STRIPE_SECRET_KEY absent throws a clear, fail-closed error", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    vi.resetModules();
    const { getStripe } = await import("./stripe");

    expect(() => getStripe()).toThrow("STRIPE_SECRET_KEY is not configured");
  });

  it("calling getStripe() with STRIPE_SECRET_KEY blank throws the same clear error", async () => {
    process.env.STRIPE_SECRET_KEY = "   ";
    vi.resetModules();
    const { getStripe } = await import("./stripe");

    expect(() => getStripe()).toThrow("STRIPE_SECRET_KEY is not configured");
  });

  it("calling getStripe() with a configured key returns a real Stripe client instance", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake_local_key_never_sent_anywhere";
    vi.resetModules();
    const { getStripe } = await import("./stripe");

    const client = getStripe();

    expect(client).toBeDefined();
    // Sanity check that this is genuinely a Stripe SDK instance (real
    // resource namespaces present), not a stub -- without ever calling
    // a method that would make a network request.
    expect(client.checkout).toBeDefined();
    expect(client.accounts).toBeDefined();
  });

  it("repeated calls to getStripe() within the same module instance return the exact same client", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake_local_key_never_sent_anywhere";
    vi.resetModules();
    const { getStripe } = await import("./stripe");

    const first = getStripe();
    const second = getStripe();
    const third = getStripe();

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("existing behavior with a key present is otherwise unchanged: no error, no throw, immediate return", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake_local_key_never_sent_anywhere";
    vi.resetModules();
    const { getStripe } = await import("./stripe");

    expect(() => getStripe()).not.toThrow();
  });
});
