import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// BUNDLE-DELETE-SAFETY-1: deleteBundle authenticates on the server,
// deletes only where the submitted id AND the session author match,
// asks for the deleted row's id back, and reports success only for
// exactly one returned row with exactly that id. Everything else fails
// closed with one fixed message: no revalidation, no success redirect,
// no second attempt, and a log line that carries only an outcome label.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => mockRevalidatePath(p) }));

const mockRedirectIfRecoverySessionActive = vi.fn();
vi.mock("@/lib/recovery-guard", () => ({
  redirectIfRecoverySessionActive: () => mockRedirectIfRecoverySessionActive(),
}));

// Service-role paths: a delete must never reach either.
const mockCreateCatalogWriteClient = vi.fn(() => {
  throw new Error("SERVICE_ROLE_CATALOG_WRITER_USED");
});
vi.mock("@/lib/catalog-write-client", () => ({
  createCatalogWriteClient: () => mockCreateCatalogWriteClient(),
}));
const mockCreateAdminClient = vi.fn(() => {
  throw new Error("SERVICE_ROLE_ADMIN_CLIENT_USED");
});
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

// Payment modules: loading any of them while importing deleteBundle's
// module graph is recorded, and the test below requires none.
const loadedPaymentModules = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/pok", () => (loadedPaymentModules.push("pok"), {}));
vi.mock("@/lib/pok-checkout", () => (loadedPaymentModules.push("pok-checkout"), {}));
vi.mock("@/lib/pok-repository", () => (loadedPaymentModules.push("pok-repository"), {}));
vi.mock("@/lib/checkout-regime", () => (loadedPaymentModules.push("checkout-regime"), {}));
vi.mock("@/lib/stripe", () => (loadedPaymentModules.push("lib/stripe"), {}));
vi.mock("stripe", () => (loadedPaymentModules.push("stripe"), {}));

const AUTHOR_ID = "a0000000-0000-4000-8000-00000000000a";
const OTHER_AUTHOR_ID = "a0000000-0000-4000-8000-00000000000b";
const BUNDLE_ID = "b0000000-0000-4000-8000-0000000000d1";
const FIXTURE_BUNDLE_ID = "b0000000-0000-4000-8000-0000000000f1";
const DB_ERROR_TEXT = 'violates foreign key constraint "secret_internal_name"';

type DeleteResult = { data: unknown; error: unknown };

let calls: string[];
let deleteResult: DeleteResult;
let sessionUser: { id: string } | null;

function makeSessionClient() {
  return {
    auth: {
      getUser: async () => ({ data: { user: sessionUser } }),
    },
    from(table: string) {
      calls.push(`from:${table}`);
      const builder = {
        delete() {
          calls.push("delete");
          return builder;
        },
        eq(column: string, value: unknown) {
          calls.push(`eq:${column}=${String(value)}`);
          return builder;
        },
        select(columns: string) {
          calls.push(`select:${columns}`);
          return Promise.resolve(deleteResult);
        },
        update() {
          calls.push("update");
          return builder;
        },
        insert() {
          calls.push("insert");
          return builder;
        },
      };
      return builder;
    },
    rpc(name: string) {
      calls.push(`rpc:${name}`);
      return Promise.resolve({ data: null, error: null });
    },
  };
}

const mockCreateClient = vi.fn(async () => makeSessionClient());
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { deleteBundle } = await import("./actions");
const { isBundleId, isConfirmedBundleDeletion } = await import("@/lib/bundle-delete");

const UNCONFIRMED_TARGET =
  "/dashboard/bundles?error=" +
  encodeURIComponent("We could not confirm that the bundle was deleted. Reload this page to check before trying again.");
const SUCCESS_TARGET = "/dashboard/bundles?success=Bundle+deleted";

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  calls = [];
  sessionUser = { id: AUTHOR_ID };
  deleteResult = { data: [{ id: BUNDLE_ID }], error: null };
  mockRedirect.mockClear();
  mockRevalidatePath.mockClear();
  mockCreateClient.mockClear();
  mockCreateCatalogWriteClient.mockClear();
  mockCreateAdminClient.mockClear();
  mockRedirectIfRecoverySessionActive.mockClear();
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  vi.unstubAllEnvs();
});

async function runDelete(...args: unknown[]): Promise<string> {
  const run = (deleteBundle as (...a: unknown[]) => Promise<void>)(...args);
  const signal = await run.then(
    () => {
      throw new Error("deleteBundle returned without redirecting");
    },
    (e: unknown) => e,
  );
  expect(signal).toBeInstanceOf(RedirectSignal);
  return (signal as RedirectSignal).target;
}

const EXPECTED_DELETE_CALLS = [
  "from:bundles",
  "delete",
  `eq:id=${BUNDLE_ID}`,
  `eq:author_id=${AUTHOR_ID}`,
  "select:id",
];

function expectFailedClosed(target: string) {
  expect(target).toBe(UNCONFIRMED_TARGET);
  expect(mockRedirect).toHaveBeenCalledTimes(1);
  expect(mockRedirect).not.toHaveBeenCalledWith(SUCCESS_TARGET);
  expect(mockRevalidatePath).not.toHaveBeenCalled();
}

describe("isBundleId / isConfirmedBundleDeletion", () => {
  it("accepts only a canonical lowercase UUID string", () => {
    expect(isBundleId(BUNDLE_ID)).toBe(true);
    for (const bad of [BUNDLE_ID.toUpperCase(), "bundle-1", "", ` ${BUNDLE_ID}`, 42, null, undefined, { id: BUNDLE_ID }]) {
      expect(isBundleId(bad)).toBe(false);
    }
  });

  it("confirms exactly one row carrying exactly the requested id, and nothing else", () => {
    expect(isConfirmedBundleDeletion([{ id: BUNDLE_ID }], BUNDLE_ID)).toBe(true);
    const refused: unknown[] = [
      null,
      undefined,
      [],
      {},
      { id: BUNDLE_ID },
      [{}],
      [{ id: null }],
      [null],
      [BUNDLE_ID],
      [{ id: FIXTURE_BUNDLE_ID }],
      [{ id: BUNDLE_ID.toUpperCase() }],
      [{ id: BUNDLE_ID }, { id: BUNDLE_ID }],
      [{ id: BUNDLE_ID }, { id: FIXTURE_BUNDLE_ID }],
    ];
    for (const rows of refused) {
      expect(isConfirmedBundleDeletion(rows, BUNDLE_ID)).toBe(false);
    }
  });
});

describe("deleteBundle: confirmed success", () => {
  it("deletes once through the session client, bound to the id and the session author, and redirects with the explicit success", async () => {
    const target = await runDelete(BUNDLE_ID);

    expect(target).toBe(SUCCESS_TARGET);
    expect(calls).toEqual(EXPECTED_DELETE_CALLS);
    expect(mockRedirectIfRecoverySessionActive).toHaveBeenCalledOnce();
    expect(mockRedirect).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("revalidates only /dashboard/bundles, once, before the success redirect", async () => {
    await runDelete(BUNDLE_ID);
    expect(mockRevalidatePath.mock.calls).toEqual([["/dashboard/bundles"]]);
    expect(mockRevalidatePath.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedirect.mock.invocationCallOrder[0],
    );
  });

  it("never uses a service-role client", async () => {
    await runDelete(BUNDLE_ID);
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

describe("deleteBundle: every unconfirmed result fails closed", () => {
  const cases: [string, DeleteResult][] = [
    ["zero rows", { data: [], error: null }],
    ["null data", { data: null, error: null }],
    ["undefined data", { data: undefined, error: null }],
    ["a non-array object", { data: { id: BUNDLE_ID }, error: null }],
    ["a row with no id", { data: [{}], error: null }],
    ["a row with a null id", { data: [{ id: null }], error: null }],
    ["a bare string row", { data: [BUNDLE_ID], error: null }],
    ["two copies of the row", { data: [{ id: BUNDLE_ID }, { id: BUNDLE_ID }], error: null }],
    ["two different rows", { data: [{ id: BUNDLE_ID }, { id: FIXTURE_BUNDLE_ID }], error: null }],
    ["another bundle's id", { data: [{ id: FIXTURE_BUNDLE_ID }], error: null }],
    ["a database error with no data", { data: null, error: { message: DB_ERROR_TEXT, code: "23503" } }],
    ["a database error alongside a matching row", { data: [{ id: BUNDLE_ID }], error: { message: DB_ERROR_TEXT } }],
  ];

  for (const [label, result] of cases) {
    it(`${label}: fixed failure message, no revalidation, no success, no second attempt`, async () => {
      deleteResult = result;
      const target = await runDelete(BUNDLE_ID);

      expectFailedClosed(target);
      expect(calls).toEqual(EXPECTED_DELETE_CALLS);
      expect(target).not.toContain(BUNDLE_ID);
      expect(target).not.toContain("secret_internal_name");
      expect(target).not.toContain("23503");
    });
  }

  it("logs one safe label and outcome, with no ids, user data or database error", async () => {
    deleteResult = { data: null, error: { message: DB_ERROR_TEXT, code: "23503", details: AUTHOR_ID } };
    await runDelete(BUNDLE_ID);
    expect(consoleError.mock.calls).toEqual([
      ["deleteBundle: deletion not confirmed", { outcome: "database_error" }],
    ]);

    consoleError.mockClear();
    deleteResult = { data: [], error: null };
    await runDelete(BUNDLE_ID);
    expect(consoleError.mock.calls).toEqual([
      ["deleteBundle: deletion not confirmed", { outcome: "unconfirmed_result" }],
    ]);
  });
});

describe("deleteBundle: authorization", () => {
  it("another author's bundle: bound to the session author, zero rows back, fails closed", async () => {
    sessionUser = { id: OTHER_AUTHOR_ID };
    deleteResult = { data: [], error: null };
    const target = await runDelete(BUNDLE_ID);

    expectFailedClosed(target);
    expect(calls).toContain(`eq:author_id=${OTHER_AUTHOR_ID}`);
    expect(calls).not.toContain(`eq:author_id=${AUTHOR_ID}`);
  });

  it("an attacker-supplied author id is ignored: the filter always uses the session user", async () => {
    await runDelete(BUNDLE_ID, OTHER_AUTHOR_ID, { author_id: OTHER_AUTHOR_ID, authorId: OTHER_AUTHOR_ID });
    expect(calls).toEqual(EXPECTED_DELETE_CALLS);
    expect(calls.join(" ")).not.toContain(OTHER_AUTHOR_ID);
  });

  it("no session: redirects to /login and never touches bundles", async () => {
    sessionUser = null;
    const target = await runDelete(BUNDLE_ID);
    expect(target).toBe("/login");
    expect(calls).toEqual([]);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  for (const bad of ["", "bundle-1", BUNDLE_ID.toUpperCase(), `${BUNDLE_ID}'`, 42, null, undefined, { id: BUNDLE_ID }]) {
    it(`a malformed bundle id (${JSON.stringify(bad)}) is refused before any database call`, async () => {
      const target = await runDelete(bad);
      expectFailedClosed(target);
      expect(calls).toEqual([]);
      expect(consoleError.mock.calls).toEqual([
        ["deleteBundle: deletion not confirmed", { outcome: "invalid_request" }],
      ]);
    });
  }
});

describe("deleteBundle: no payment path", () => {
  it("the delete action, its helper and its button import nothing from POK, Stripe, checkout or payments", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const sources = [
      path.join(dir, "actions.ts"),
      path.join(dir, "delete-bundle-button.tsx"),
      path.resolve(dir, "../../../../lib/bundle-delete.ts"),
    ];
    const specifiers: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/\brequire\(|\bimport\(/);
      for (const match of source.matchAll(/\bfrom\s+"([^"]+)"/g)) {
        specifiers.push(match[1]);
      }
    }
    expect(specifiers).toContain("./actions");
    expect(specifiers).toContain("@/lib/bundle-delete");
    for (const specifier of specifiers) {
      expect(specifier).not.toMatch(/pok|stripe|checkout|payment/i);
    }
  });

  it("loading deleteBundle and its button loads no POK, Stripe or checkout module", async () => {
    await import("./delete-bundle-button");
    await runDelete(BUNDLE_ID);
    expect(loadedPaymentModules).toEqual([]);
  });

  it("a successful delete calls no RPC and touches no table but bundles", async () => {
    await runDelete(BUNDLE_ID);
    expect(calls.filter((c) => c.startsWith("from:") || c.startsWith("rpc:"))).toEqual(["from:bundles"]);
  });
});
