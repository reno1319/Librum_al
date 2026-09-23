import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGING_SUPABASE_URL } from "@/lib/protected-staging";

// ALL-WIRING-5: bundles now carry a real ALL price and can be published
// free or (with permission) paid, which is exactly when an unconditional
// checkout closure is most tempting to "just connect". This file proves,
// under every combination of both paid-mode variables, that a direct
// buyBundle invocation still ends in the same fixed redirect having made
// ZERO database reads or writes, ZERO RPC calls (so no
// create_bundle_checkout_snapshot, no checkout intent), ZERO Stripe
// calls and ZERO POK calls.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));

// Every table and RPC access is recorded; nothing is ever expected here.
const tableAccess = vi.fn();
const rpcCalls = vi.fn();
const mockCreateClient = vi.fn(async () => ({
  auth: { getUser: async () => ({ data: { user: { id: "reader-1" } } }) },
  from: (table: string) => {
    tableAccess(table);
    throw new Error(`buyBundle touched table ${table}`);
  },
  rpc: (name: string) => {
    rpcCalls(name);
    throw new Error(`buyBundle called rpc ${name}`);
  },
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn(() => {
  throw new Error("buyBundle reached the admin client");
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const stripeCalls = vi.fn();
vi.mock("@/lib/stripe", () => ({
  getStripe: () => {
    stripeCalls();
    throw new Error("buyBundle reached Stripe");
  },
}));
const pokCalls = vi.fn();
vi.mock("@/lib/pok-checkout", () => ({
  startPokCheckout: () => {
    pokCalls("startPokCheckout");
    throw new Error("buyBundle reached POK");
  },
  fulfillPokCheckout: () => {
    pokCalls("fulfillPokCheckout");
    throw new Error("buyBundle reached POK");
  },
  probeProviderAttempt: () => {
    pokCalls("probeProviderAttempt");
    throw new Error("buyBundle reached POK");
  },
}));

const { buyBundle } = await import("./actions");

const BUNDLE_ID = "bundle-1";
const EXPECTED_TARGET =
  `/bundles/${BUNDLE_ID}?error=` + encodeURIComponent("This bundle isn't available for purchase right now");

const STAGING = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "staging",
  NEXT_PUBLIC_SUPABASE_URL: STAGING_SUPABASE_URL,
  NEW_CHECKOUT_REGIME: "librum_ledger_v1",
  LEDGER_PAYMENT_PROVIDER: "pok",
  POK_ENVIRONMENT: "staging",
};

const MODES: Array<[string, string | undefined]> = [
  ["absent", undefined],
  ["empty", ""],
  ["correct for its own variable", "__CORRECT__"],
  ["malformed (wrong case)", "CONTROLLED_STAGING_CHECKOUT_TEST"],
  ["malformed (the other variable's value)", "__OTHER__"],
  ["production", "production"],
];

function value(mode: string | undefined, own: string, other: string): string | undefined {
  if (mode === "__CORRECT__") return own;
  if (mode === "__OTHER__") return other;
  return mode;
}

const CHECKOUT_OK = "controlled_staging_checkout_test";
const PUBLISHING_OK = "controlled_staging_publishing_test";

const COMBINATIONS: Array<[string, string, string | undefined, string | undefined, Record<string, string>]> = [];
for (const [deployLabel, deployEnv] of [
  ["protected staging deployment", STAGING],
  ["Vercel Production", { ...STAGING, VERCEL_ENV: "production", VERCEL_GIT_COMMIT_REF: "main" }],
] as const) {
  for (const [checkoutLabel, checkoutMode] of MODES) {
    for (const [publishingLabel, publishingMode] of MODES) {
      COMBINATIONS.push([
        deployLabel,
        `checkout ${checkoutLabel} / publishing ${publishingLabel}`,
        value(checkoutMode, CHECKOUT_OK, PUBLISHING_OK),
        value(publishingMode, PUBLISHING_OK, CHECKOUT_OK),
        deployEnv,
      ]);
    }
  }
}

describe("buyBundle: closed under every paid-mode combination, with zero side effects (ALL-WIRING-5)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    tableAccess.mockClear();
    rpcCalls.mockClear();
    stripeCalls.mockClear();
    pokCalls.mockClear();
    mockCreateAdminClient.mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(COMBINATIONS)("%s, %s", async (_deploy, _modes, checkoutMode, publishingMode, deployEnv) => {
    for (const [key, v] of Object.entries(deployEnv)) vi.stubEnv(key, v);
    vi.stubEnv("PAID_CHECKOUT_MODE", checkoutMode as string);
    vi.stubEnv("PAID_PUBLISHING_MODE", publishingMode as string);

    await expect(buyBundle(BUNDLE_ID)).rejects.toMatchObject({ target: EXPECTED_TARGET });

    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(tableAccess).not.toHaveBeenCalled();
    expect(rpcCalls).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(stripeCalls).not.toHaveBeenCalled();
    expect(pokCalls).not.toHaveBeenCalled();
  });

  it("covers all 72 combinations", () => {
    expect(COMBINATIONS).toHaveLength(72);
  });
});

describe("buyBundle and the bundle checkout RPC: structurally untouched by the ALL wiring (ALL-WIRING-5)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const strip = (s: string) =>
    s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const actions = strip(readFileSync(path.join(here, "actions.ts"), "utf8"));

  it("buyBundle's body ends in the unconditional redirect: no branch, no price, no provider", () => {
    const body = actions.slice(actions.indexOf("export async function buyBundle("));
    const afterLogin = body.slice(body.indexOf("/login?next="));
    // After the login redirect, the ONLY statement left is the closure.
    expect(afterLogin).toMatch(
      /^\/login\?next=\/bundles\/\$\{bundleId\}`\);\s*\}\s*redirect\(`\/bundles\/\$\{bundleId\}\?error=\$\{encodeURIComponent\(BUNDLE_CHECKOUT_UNAVAILABLE_MESSAGE\)\}`\);\s*\}\s*$/,
    );
  });

  it("buyBundle reads no price column and consults no paid mode", () => {
    for (const forbidden of [
      "price_all",
      "price_cents",
      "PAID_CHECKOUT_MODE",
      "PAID_PUBLISHING_MODE",
      "canStartPaidCheckout",
      "canPublishPaidTitle",
      "create_bundle_checkout_snapshot",
      "create_book_checkout_intent",
      "getStripe",
      "startPokCheckout",
      ".from(",
      ".rpc(",
    ]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  it("the page imports no bundle checkout control and renders no form", () => {
    const page = strip(readFileSync(path.join(here, "page.tsx"), "utf8"));
    expect(page).not.toContain("buyBundle");
    expect(page).not.toContain("BuyBundleButton");
    expect(page).not.toContain("<form");
  });
});
