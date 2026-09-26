import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyBundleWriteFailure,
  isExactBundleMembership,
  isExactBundleState,
} from "@/lib/bundle-membership";

// BUNDLE-MEMBERSHIP-AUTH-1 (Patch 13): every trusted membership path of
// createBundle and updateBundle, and every failure class.
//
// Since migrations 20260926061034 / 20260926061037 the ONLY writers the
// application uses are the service-role functions
// create_bundle_with_membership and update_bundle_with_membership, each
// ONE transaction covering the bundle's details and its membership. This
// suite pins, through the real Server Actions:
//
//   * privileged authority (createCatalogWriteClient) is created only
//     after the maintenance and recovery gates, authentication, the
//     ownership read (update), price parsing, the paid-repricing gate
//     (update) and the book-selection check -- and never on a refusal;
//   * the RPC payload is bound to the server: a server-generated bundle id
//     (create) or the owned bundle's id (update), and the author id that
//     auth.getUser() returned -- never a client-supplied author, bundle
//     owner, status or path;
//   * updateBundle performs NO separate bundles update: details, the
//     PAID-REPRICING-1 compare-and-set and membership travel in the one
//     update_bundle_with_membership call;
//   * success is reported ONLY when the returned rows prove exactly the
//     expected state; everything else fails closed with a fixed message
//     and no raw database text -- and the message distinguishes a
//     database error (the transaction rolled back, nothing changed) from
//     an outcome the action cannot confirm (no SQLSTATE, or a successful
//     response that fails the proof).

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let events: string[] = [];
let recoveryActive = false;
vi.mock("@/lib/recovery-guard", () => ({
  redirectIfRecoverySessionActive: vi.fn(async () => {
    events.push("recovery-gate");
    if (recoveryActive) mockRedirect("/reset-password");
  }),
}));

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BUNDLE_ID = "e1f2a3b4-3333-4333-8333-abcdef333333";
const BOOK_A = "b0000000-0000-4000-8000-00000000000a";
const BOOK_B = "b0000000-0000-4000-8000-00000000000b";
const BOOK_C = "b0000000-0000-4000-8000-00000000000c";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RAW_DB_ERROR = 'bundle membership: every book must be the author\'s own published book (secret-detail-42)';

type Rpc = { fn: string; args: Record<string, unknown> };

let signedIn = true;
// The author's own published books, as resolveBookSelection() reads them.
let ownPublishedBooks: string[] = [BOOK_A, BOOK_B, BOOK_C];
let existingBundle: { id: string; status: string; price_all: number | null } | null = null;
// Any table write through the catalog writer is recorded here: since the
// correction, updateBundle has none (it is one RPC).
let writerTableWrites: string[] = [];
// null = echo the exact membership that was asked for (the real success
// shape); a function = compute the result from the call.
let rpcResult: ((call: Rpc) => { data: unknown; error: unknown }) | null = null;
let rpcCalls: Rpc[] = [];
let sessionWrites: string[] = [];

function thenable(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "is", "in", "select", "order"]) chain[method] = () => chain;
  chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return chain;
}

const sessionClient = {
  auth: {
    getUser: async () => {
      events.push("getUser");
      return { data: { user: signedIn ? { id: USER_ID } : null } };
    },
  },
  from: (table: string) => {
    if (table === "books") {
      return {
        select: () => {
          const filters: Record<string, unknown> = {};
          const chain: Record<string, unknown> = {
            eq: (c: string, v: unknown) => ((filters[c] = v), chain),
            in: (c: string, v: string[]) => ((filters[c] = v), chain),
            then: (onFulfilled: (v: unknown) => unknown) => {
              events.push("selection-read");
              const requested = (filters.id as string[]) ?? [];
              const ok = filters.author_id === USER_ID && filters.status === "published";
              const rows = ok ? [...new Set(requested)].filter((id) => ownPublishedBooks.includes(id)) : [];
              return Promise.resolve({ data: rows.map((id) => ({ id })) }).then(onFulfilled);
            },
          };
          return chain;
        },
      };
    }
    if (table === "bundles") {
      return {
        select: () => {
          const chain = {
            eq: () => chain,
            maybeSingle: async () => (events.push("ownership-read"), { data: existingBundle }),
          };
          return chain;
        },
        insert: () => {
          sessionWrites.push("bundles:insert");
          return thenable({ data: null, error: { message: "session insert must not happen" } });
        },
      };
    }
    if (table === "bundle_books") {
      return {
        insert: () => (sessionWrites.push("bundle_books:insert"), thenable({ error: null })),
        delete: () => (sessionWrites.push("bundle_books:delete"), thenable({ error: null })),
      };
    }
    throw new Error(`unexpected session table ${table}`);
  },
  rpc: async (fn: string) => {
    sessionWrites.push(`rpc:${fn}`);
    return { data: null, error: { code: "42501", message: `permission denied for function ${fn}` } };
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => (events.push("createClient"), sessionClient) }));

const catalogWriter = {
  from: (table: string) => {
    const record = (op: string) => () => {
      events.push(`${table}:${op}`);
      writerTableWrites.push(`${table}:${op}`);
      return thenable({ data: [{ id: BUNDLE_ID }], error: null });
    };
    return { update: record("update"), insert: record("insert"), delete: record("delete"), upsert: record("upsert") };
  },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    events.push(`rpc:${fn}`);
    const call = { fn, args };
    rpcCalls.push(call);
    if (rpcResult) return rpcResult(call);
    const ids = args.p_book_ids as string[];
    if (fn === "update_bundle_with_membership") return { data: stateRows(args), error: null };
    return { data: ids.map((id) => ({ member_bundle_id: args.p_bundle_id, member_book_id: id })), error: null };
  },
};
const mockCreateCatalogWriteClient = vi.fn(() => (events.push("createCatalogWriteClient"), catalogWriter));
vi.mock("@/lib/catalog-write-client", () => ({ createCatalogWriteClient: () => mockCreateCatalogWriteClient() }));

const { createBundle, updateBundle } = await import("./actions");

const CREATE_FAILED = "/dashboard/bundles?error=" + encodeURIComponent("Could not create the bundle. Please try again.");
const CREATE_UNCONFIRMED =
  "/dashboard/bundles?error=" +
  encodeURIComponent("We could not confirm whether the bundle was created. Check your bundles before trying again.");
const EDIT = `/dashboard/bundles/${BUNDLE_ID}/edit?error=`;
const SAVE_ROLLED_BACK = EDIT + encodeURIComponent("Could not save the bundle, so nothing was changed. Please try again.");
const SAVE_UNCONFIRMED =
  EDIT +
  encodeURIComponent("We could not confirm whether your changes were saved. Reload this bundle to check before trying again.");
const SAVE_CHANGED =
  EDIT +
  encodeURIComponent("This title changed while you were editing it, so nothing was saved. Reload the page and try again.");
const CREATED = "/dashboard/bundles?success=Bundle+created+as+a+draft";
const UPDATED = "/dashboard/bundles?success=Bundle+updated";

function form(bookIds: string[] = [BOOK_A, BOOK_B], extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set("title", "The Collection");
  fd.set("description", "Two books");
  fd.set("price", "0");
  for (const id of bookIds) fd.append("bookIds", id);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  return "<no redirect>";
}

const rows = (bundleId: string, ids: string[]) => ids.map((id) => ({ member_bundle_id: bundleId, member_book_id: id }));
// update_bundle_with_membership's success shape: every member row carries
// the persisted details.
function stateRows(args: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return (args.p_book_ids as string[]).map((id) => ({
    member_bundle_id: args.p_bundle_id,
    member_book_id: id,
    bundle_title: args.p_title,
    bundle_description: args.p_description,
    bundle_price_all: args.p_price_all,
    bundle_status: "draft",
    ...overrides,
  }));
}
const DETAILS = { title: "The Collection", description: "Two books", priceAll: 0 };

beforeEach(() => {
  vi.unstubAllEnvs();
  events = [];
  recoveryActive = false;
  signedIn = true;
  ownPublishedBooks = [BOOK_A, BOOK_B, BOOK_C];
  existingBundle = { id: BUNDLE_ID, status: "draft", price_all: 0 };
  writerTableWrites = [];
  rpcResult = null;
  rpcCalls = [];
  sessionWrites = [];
  mockRedirect.mockClear();
  mockCreateCatalogWriteClient.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ============================================================
// 1. The proof itself.
// ============================================================
describe("isExactBundleMembership", () => {
  const expected = [BOOK_A, BOOK_B];

  it("accepts exactly the expected set bound to the bundle, in any order", () => {
    expect(isExactBundleMembership(rows(BUNDLE_ID, [BOOK_A, BOOK_B]), BUNDLE_ID, expected)).toBe(true);
    expect(isExactBundleMembership(rows(BUNDLE_ID, [BOOK_B, BOOK_A]), BUNDLE_ID, expected)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["undefined", undefined],
    ["an object", { member_bundle_id: BUNDLE_ID, member_book_id: BOOK_A }],
    ["a string", "[]"],
    ["zero rows", []],
    ["a missing row", rows(BUNDLE_ID, [BOOK_A])],
    ["an extra row", rows(BUNDLE_ID, [BOOK_A, BOOK_B, BOOK_C])],
    ["a duplicated row in place of a missing one", rows(BUNDLE_ID, [BOOK_A, BOOK_A])],
    ["a duplicated row on top of the set", rows(BUNDLE_ID, [BOOK_A, BOOK_B, BOOK_B])],
    ["a mismatched book", rows(BUNDLE_ID, [BOOK_A, BOOK_C])],
    ["another bundle's rows", rows("other-bundle", [BOOK_A, BOOK_B])],
    ["one row bound to another bundle", [...rows(BUNDLE_ID, [BOOK_A]), ...rows("other-bundle", [BOOK_B])]],
    ["a null row", [null, ...rows(BUNDLE_ID, [BOOK_B])]],
    ["a non-object row", ["x", ...rows(BUNDLE_ID, [BOOK_B])]],
    ["a numeric book id", [{ member_bundle_id: BUNDLE_ID, member_book_id: 1 }, ...rows(BUNDLE_ID, [BOOK_B])]],
    ["the legacy row shape", [{ bundle_id: BUNDLE_ID, book_id: BOOK_A }, { bundle_id: BUNDLE_ID, book_id: BOOK_B }]],
  ])("rejects %s", (_label, result) => {
    expect(isExactBundleMembership(result, BUNDLE_ID, expected)).toBe(false);
  });

  it("never matches an invalid EXPECTED set: fewer than two or duplicated ids", () => {
    expect(isExactBundleMembership(rows(BUNDLE_ID, [BOOK_A]), BUNDLE_ID, [BOOK_A])).toBe(false);
    expect(isExactBundleMembership([], BUNDLE_ID, [])).toBe(false);
    expect(isExactBundleMembership(rows(BUNDLE_ID, [BOOK_A, BOOK_A]), BUNDLE_ID, [BOOK_A, BOOK_A])).toBe(false);
    // Two distinct ids hidden in a three-id request: the rows match the
    // distinct set exactly, but the request itself was not a valid set.
    expect(isExactBundleMembership(rows(BUNDLE_ID, [BOOK_A, BOOK_B]), BUNDLE_ID, [BOOK_A, BOOK_A, BOOK_B])).toBe(false);
  });
});

describe("isExactBundleState", () => {
  const args = { p_bundle_id: BUNDLE_ID, p_book_ids: [BOOK_A, BOOK_B], p_title: "The Collection", p_description: "Two books", p_price_all: 0 };

  it("accepts the exact membership carrying exactly the submitted details", () => {
    expect(isExactBundleState(stateRows(args), BUNDLE_ID, [BOOK_A, BOOK_B], DETAILS)).toBe(true);
    expect(isExactBundleState(stateRows(args, { bundle_status: "published" }), BUNDLE_ID, [BOOK_A, BOOK_B], DETAILS)).toBe(true);
  });

  it.each<[string, unknown]>([
    ["membership-only rows (no details)", rows(BUNDLE_ID, [BOOK_A, BOOK_B])],
    ["another title", stateRows(args, { bundle_title: "Other" })],
    ["another description", stateRows(args, { bundle_description: "" })],
    ["another price", stateRows(args, { bundle_price_all: 199 })],
    ["a null price for a free save", stateRows(args, { bundle_price_all: null })],
    ["a missing status", stateRows(args, { bundle_status: undefined })],
    ["details differing on ONE row", [...stateRows(args).slice(0, 1), ...stateRows(args, { bundle_title: "Other" }).slice(1)]],
    ["a partial set", stateRows({ ...args, p_book_ids: [BOOK_A] })],
    ["an extra member", stateRows({ ...args, p_book_ids: [BOOK_A, BOOK_B, BOOK_C] })],
    ["another bundle", stateRows({ ...args, p_bundle_id: "other-bundle" })],
    ["null", null],
  ])("rejects %s", (_label, result) => {
    expect(isExactBundleState(result, BUNDLE_ID, [BOOK_A, BOOK_B], DETAILS)).toBe(false);
  });
});

describe("classifyBundleWriteFailure", () => {
  it.each<[string, unknown, string]>([
    ["the compare-and-set refusal", { code: "LB409", message: "changed" }, "changed"],
    ["an in-transaction invariant violation", { code: "23000", message: "stored membership does not equal" }, "rolled_back"],
    ["a refused selection", { code: "42501", message: "x" }, "rolled_back"],
    ["an input refusal", { code: "22023", message: "x" }, "rolled_back"],
    ["a lost response (no SQLSTATE)", { code: "", message: "TypeError: fetch failed" }, "unconfirmed"],
    ["a PostgREST-level error", { code: "PGRST202", message: "not found" }, "unconfirmed"],
    ["a connection failure (the COMMIT may have completed)", { code: "08006", message: "connection failure" }, "unconfirmed"],
    ["a connection exception", { code: "08000", message: "x" }, "unconfirmed"],
    ["a cancelled statement (rolled back)", { code: "57014", message: "canceling statement" }, "rolled_back"],
    ["an error without a code", { message: "x" }, "unconfirmed"],
    ["a lower-case pseudo code", { code: "ab123" }, "unconfirmed"],
    ["null", null, "unconfirmed"],
  ])("%s -> %s", (_label, error, outcome) => {
    expect(classifyBundleWriteFailure(error)).toBe(outcome);
  });
});

// ============================================================
// 2. createBundle.
// ============================================================
describe("createBundle: one trusted call, bound to the server", () => {
  it("creates through create_bundle_with_membership with a server id and the authenticated author", async () => {
    const fd = form([BOOK_A, BOOK_B], {
      author_id: "attacker-author",
      bundleId: "attacker-bundle",
      bundle_id: "attacker-bundle",
      id: "attacker-bundle",
      p_bundle_id: "attacker-bundle",
      status: "published",
      p_author_id: "attacker-author",
    });
    expect(await redirectOf(createBundle(fd))).toBe(CREATED);

    expect(rpcCalls).toHaveLength(1);
    const [{ fn, args }] = rpcCalls;
    expect(fn).toBe("create_bundle_with_membership");
    expect(args).toEqual({
      p_bundle_id: expect.stringMatching(UUID_V4),
      p_author_id: USER_ID,
      p_title: "The Collection",
      p_description: "Two books",
      p_price_all: 0,
      p_book_ids: [BOOK_A, BOOK_B],
    });
    expect(args.p_bundle_id).not.toBe("attacker-bundle");
    expect(sessionWrites).toEqual([]);
  });

  it("generates a fresh id for every create", async () => {
    await redirectOf(createBundle(form()));
    await redirectOf(createBundle(form()));
    expect(rpcCalls[0].args.p_bundle_id).not.toBe(rpcCalls[1].args.p_bundle_id);
  });

  it("creates privileged authority only after every gate, and exactly once", async () => {
    await redirectOf(createBundle(form()));
    expect(events).toEqual([
      "recovery-gate",
      "createClient",
      "getUser",
      "selection-read",
      "createCatalogWriteClient",
      "rpc:create_bundle_with_membership",
    ]);
  });

  const refusals: Array<[string, () => void, () => FormData, string]> = [
    ["maintenance", () => vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active"), () => form(), "/dashboard/bundles?error="],
    ["recovery session", () => (recoveryActive = true), () => form(), "/reset-password"],
    ["signed out", () => (signedIn = false), () => form(), "/login"],
    ["missing title", () => undefined, () => form([BOOK_A, BOOK_B], { title: "  " }), "/dashboard/bundles?error=Please+fill+in+every+field"],
    ["invalid price", () => undefined, () => form([BOOK_A, BOOK_B], { price: "5" }), "/dashboard/bundles?error="],
    ["one book", () => undefined, () => form([BOOK_A]), "/dashboard/bundles?error=Choose+at+least+2+books"],
    ["no books", () => undefined, () => form([]), "/dashboard/bundles?error=Choose+at+least+2+books"],
    ["duplicate book ids", () => undefined, () => form([BOOK_A, BOOK_A]), "/dashboard/bundles?error=Choose+only+your+own+published+books"],
    ["a duplicate among three", () => undefined, () => form([BOOK_A, BOOK_B, BOOK_A]), "/dashboard/bundles?error=Choose+only+your+own+published+books"],
    ["another author's or unpublished book", () => (ownPublishedBooks = [BOOK_A]), () => form([BOOK_A, BOOK_B]), "/dashboard/bundles?error=Choose+only+your+own+published+books"],
  ];

  it.each(refusals)("%s: refused before privileged authority exists", async (_label, arrange, makeForm, target) => {
    arrange();
    expect(await redirectOf(createBundle(makeForm()))).toContain(target);
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(sessionWrites).toEqual([]);
  });

  it("the recovery gate runs before any Supabase client exists", async () => {
    recoveryActive = true;
    await redirectOf(createBundle(form()));
    expect(events).toEqual(["recovery-gate"]);
  });

  it.each<[string, (call: Rpc) => { data: unknown; error: unknown }]>([
    ["a database error", () => ({ data: null, error: { code: "42501", message: RAW_DB_ERROR } })],
    ["a unique violation", () => ({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "bundles_pkey"' } })],
    ["an in-transaction exact-set violation", () => ({ data: null, error: { code: "23000", message: "bundle membership: stored membership does not equal the requested set" } })],
  ])("%s: the create rolled back -- fixed message", async (_label, result) => {
    rpcResult = result;
    const target = await redirectOf(createBundle(form()));
    expect(target).toBe(CREATE_FAILED);
    expect(decodeURIComponent(target)).not.toContain("secret-detail-42");
    expect(decodeURIComponent(target)).not.toContain("bundles_pkey");
    expect(console.error).toHaveBeenCalledOnce();
    expect(sessionWrites).toEqual([]);
  });

  it.each<[string, (call: Rpc) => { data: unknown; error: unknown }]>([
    ["a lost response (error without SQLSTATE)", () => ({ data: null, error: { code: "", message: "TypeError: fetch failed" } })],
    ["a connection failure (08006)", () => ({ data: null, error: { code: "08006", message: "connection failure" } })],
    ["null data and no error", () => ({ data: null, error: null })],
    ["zero rows", () => ({ data: [], error: null })],
    ["a missing row", (c) => ({ data: rows(c.args.p_bundle_id as string, [BOOK_A]), error: null })],
    ["an extra row", (c) => ({ data: rows(c.args.p_bundle_id as string, [BOOK_A, BOOK_B, BOOK_C]), error: null })],
    ["a duplicated row", (c) => ({ data: rows(c.args.p_bundle_id as string, [BOOK_A, BOOK_A]), error: null })],
    ["rows bound to another bundle", () => ({ data: rows(BUNDLE_ID, [BOOK_A, BOOK_B]), error: null })],
    ["a mismatched book", (c) => ({ data: rows(c.args.p_bundle_id as string, [BOOK_A, BOOK_C]), error: null })],
    ["a non-array result", (c) => ({ data: { member_bundle_id: c.args.p_bundle_id, member_book_id: BOOK_A }, error: null })],
    ["rows AND an error without SQLSTATE", (c) => ({ data: rows(c.args.p_bundle_id as string, [BOOK_A, BOOK_B]), error: { message: RAW_DB_ERROR } })],
  ])("%s: cannot be confirmed -- never success, never 'nothing changed'", async (_label, result) => {
    rpcResult = result;
    const target = await redirectOf(createBundle(form()));
    expect(target).toBe(CREATE_UNCONFIRMED);
    expect(decodeURIComponent(target)).not.toContain("secret-detail-42");
    expect(decodeURIComponent(target)).not.toContain("bundles_pkey");
    expect(console.error).toHaveBeenCalledOnce();
    expect(sessionWrites).toEqual([]);
  });

  it("a rejected promise from the writer is not reported as success", async () => {
    rpcResult = () => {
      throw new Error("network down");
    };
    await expect(createBundle(form())).rejects.toThrow("network down");
    expect(mockRedirect).not.toHaveBeenCalledWith(CREATED);
  });
});

// ============================================================
// 3. updateBundle.
// ============================================================
describe("updateBundle: the owned bundle, the authenticated author, ONE atomic save", () => {
  it("saves details and membership through update_bundle_with_membership only -- no separate bundles update", async () => {
    const fd = form([BOOK_C, BOOK_A], {
      author_id: "attacker-author",
      p_author_id: "attacker-author",
      bundle_id: "attacker-bundle",
      bundleId: "attacker-bundle",
      id: "attacker-bundle",
      p_bundle_id: "attacker-bundle",
      status: "published",
      p_expected_status: "published",
      price_cents: "999",
      // Padded input is trimmed before it is sent AND before the proof.
      title: "  The Collection  ",
      description: "  Two books  ",
    });
    expect(await redirectOf(updateBundle(BUNDLE_ID, fd))).toBe(UPDATED);
    expect(rpcCalls).toEqual([
      {
        fn: "update_bundle_with_membership",
        args: {
          p_bundle_id: BUNDLE_ID,
          p_author_id: USER_ID,
          p_expected_status: null,
          p_check_expected_price_all: false,
          p_expected_price_all: null,
          p_title: "The Collection",
          p_description: "Two books",
          p_price_all: 0,
          p_book_ids: [BOOK_C, BOOK_A],
        },
      },
    ]);
    expect(events).toEqual([
      "recovery-gate",
      "createClient",
      "getUser",
      "ownership-read",
      "selection-read",
      "createCatalogWriteClient",
      "rpc:update_bundle_with_membership",
    ]);
    expect(writerTableWrites).toEqual([]);
    expect(sessionWrites).toEqual([]);
  });

  it.each<[string, { status: string; price_all: number | null }, string, Record<string, unknown>]>([
    ["a free price: no condition", { status: "published", price_all: 199 }, "0", { p_expected_status: null, p_check_expected_price_all: false, p_expected_price_all: null }],
    ["a paid price on a draft: still a draft", { status: "draft", price_all: 0 }, "299", { p_expected_status: "draft", p_check_expected_price_all: false, p_expected_price_all: null }],
    ["an unchanged paid price: same status AND price", { status: "published", price_all: 299 }, "299", { p_expected_status: "published", p_check_expected_price_all: true, p_expected_price_all: 299 }],
  ])("PAID-REPRICING-1 compare-and-set travels into the transaction: %s", async (_label, row, price, guard) => {
    existingBundle = { id: BUNDLE_ID, ...row };
    rpcResult = (c) => ({ data: stateRows(c.args, { bundle_status: row.status }), error: null });
    expect(await redirectOf(updateBundle(BUNDLE_ID, form([BOOK_A, BOOK_B], { price })))).toBe(UPDATED);
    expect(rpcCalls[0].args).toMatchObject(guard);
  });

  const refusals: Array<[string, () => void, () => FormData, string]> = [
    ["maintenance", () => vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active"), () => form(), `/dashboard/bundles/${BUNDLE_ID}/edit?error=`],
    ["recovery session", () => (recoveryActive = true), () => form(), "/reset-password"],
    ["signed out", () => (signedIn = false), () => form(), "/login"],
    ["not the author's bundle", () => (existingBundle = null), () => form(), "/dashboard/bundles"],
    ["missing title", () => undefined, () => form([BOOK_A, BOOK_B], { title: "" }), "Please+fill+in+every+field"],
    ["invalid price", () => undefined, () => form([BOOK_A, BOOK_B], { price: "1e3" }), `/dashboard/bundles/${BUNDLE_ID}/edit?error=`],
    ["paid repricing of a published bundle while closed", () => (existingBundle = { id: BUNDLE_ID, status: "published", price_all: 0 }), () => form([BOOK_A, BOOK_B], { price: "299" }), `/dashboard/bundles/${BUNDLE_ID}/edit?error=`],
    ["one book", () => undefined, () => form([BOOK_A]), "Choose+at+least+2+books"],
    ["duplicate book ids", () => undefined, () => form([BOOK_B, BOOK_B]), "Choose+only+your+own+published+books"],
    ["another author's or unpublished book", () => (ownPublishedBooks = [BOOK_B]), () => form([BOOK_A, BOOK_B]), "Choose+only+your+own+published+books"],
  ];

  it.each(refusals)("%s: refused before privileged authority exists", async (_label, arrange, makeForm, fragment) => {
    arrange();
    expect(await redirectOf(updateBundle(BUNDLE_ID, makeForm()))).toContain(fragment);
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(writerTableWrites).toEqual([]);
    expect(sessionWrites).toEqual([]);
  });

  it("a stale compare-and-set (LB409) is reported as 'changed, nothing saved'", async () => {
    rpcResult = () => ({ data: null, error: { code: "LB409", message: "bundle update: the bundle changed since it was read" } });
    expect(await redirectOf(updateBundle(BUNDLE_ID, form()))).toBe(SAVE_CHANGED);
    expect(rpcCalls).toHaveLength(1);
  });

  it.each<[string, (call: Rpc) => { data: unknown; error: unknown }]>([
    ["a refused selection (e.g. a book unpublished concurrently)", () => ({ data: null, error: { code: "42501", message: RAW_DB_ERROR } })],
    ["an in-transaction exact-set violation", () => ({ data: null, error: { code: "23000", message: "bundle membership: stored membership does not equal the requested set" } })],
    ["a details mismatch raised in the transaction", () => ({ data: null, error: { code: "23000", message: "bundle update: stored details do not equal the submitted details" } })],
    ["an insertion failure", () => ({ data: null, error: { code: "23503", message: "insert or update on table bundle_books violates foreign key constraint" } })],
  ])("%s: the transaction rolled back -- 'nothing was changed'", async (_label, result) => {
    rpcResult = result;
    const target = await redirectOf(updateBundle(BUNDLE_ID, form()));
    expect(target).toBe(SAVE_ROLLED_BACK);
    expect(decodeURIComponent(target)).not.toContain("secret-detail-42");
    expect(decodeURIComponent(target)).not.toContain("foreign key");
    expect(console.error).toHaveBeenCalledOnce();
    expect(sessionWrites).toEqual([]);
  });

  it.each<[string, (call: Rpc) => { data: unknown; error: unknown }]>([
    ["a lost response (error without SQLSTATE)", () => ({ data: null, error: { code: "", message: "TypeError: fetch failed" } })],
    ["a PostgREST-level error", () => ({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })],
    ["a connection failure (08006)", () => ({ data: null, error: { code: "08006", message: "connection failure" } })],
    ["null data and no error", () => ({ data: null, error: null })],
    ["zero rows", () => ({ data: [], error: null })],
    ["membership rows without details", () => ({ data: rows(BUNDLE_ID, [BOOK_A, BOOK_B]), error: null })],
    ["a partial set", (c) => ({ data: stateRows({ ...c.args, p_book_ids: [BOOK_A] }), error: null })],
    ["an extra row", (c) => ({ data: stateRows({ ...c.args, p_book_ids: [BOOK_A, BOOK_B, BOOK_C] }), error: null })],
    ["a duplicated row", (c) => ({ data: stateRows({ ...c.args, p_book_ids: [BOOK_B, BOOK_B] }), error: null })],
    ["rows bound to another bundle", (c) => ({ data: stateRows({ ...c.args, p_bundle_id: "other-bundle" }), error: null })],
    ["another title", (c) => ({ data: stateRows(c.args, { bundle_title: "Stale" }), error: null })],
    ["another description", (c) => ({ data: stateRows(c.args, { bundle_description: "Stale" }), error: null })],
    ["a missing status", (c) => ({ data: stateRows(c.args, { bundle_status: null }), error: null })],
    ["another price", (c) => ({ data: stateRows(c.args, { bundle_price_all: 199 }), error: null })],
    ["rows AND an error without SQLSTATE", (c) => ({ data: stateRows(c.args), error: { message: RAW_DB_ERROR } })],
  ])("%s: cannot be confirmed -- never success, never 'nothing changed'", async (_label, result) => {
    rpcResult = result;
    const target = await redirectOf(updateBundle(BUNDLE_ID, form()));
    expect(target).toBe(SAVE_UNCONFIRMED);
    expect(decodeURIComponent(target)).not.toContain("secret-detail-42");
    expect(console.error).toHaveBeenCalledOnce();
    expect(sessionWrites).toEqual([]);
  });

  it("a rejected promise from the writer is not reported as success", async () => {
    rpcResult = () => {
      throw new Error("network down");
    };
    await expect(updateBundle(BUNDLE_ID, form())).rejects.toThrow("network down");
    expect(mockRedirect).not.toHaveBeenCalledWith(UPDATED);
  });
});

// ============================================================
// 4. The source: no client-reachable membership write remains.
// ============================================================
describe("no session-client membership write remains in the application", () => {
  const source = readFileSync(path.join(__dirname, "actions.ts"), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");

  it("bundles/actions.ts never inserts into or deletes from bundle_books directly", () => {
    expect(code).not.toMatch(/from\("bundle_books"\)\s*\.(insert|delete|update|upsert)\(/);
    // The only bundle_books access left is publishBundle's membership read.
    expect(code.match(/from\("bundle_books"\)/g)).toHaveLength(1);
    expect(code).toMatch(/from\("bundle_books"\)\s*\.select\(/);
  });

  it("both RPCs are called on the catalog writer, never on the session client", () => {
    const calls = [...code.matchAll(/(\w+)\.rpc\("(\w+)"/g)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ["catalogWriter", "create_bundle_with_membership"],
      ["catalogWriter", "update_bundle_with_membership"],
    ]);
  });

  it("updateBundle performs no table write of its own: no bundles update before the RPC", () => {
    const start = code.indexOf("export async function updateBundle(");
    expect(start).toBeGreaterThan(-1);
    // The function ends where the next top-level declaration begins.
    const next = code.slice(start + 1).search(/\n(?:export )?(?:async )?function |\n(?:export )?(?:type|const) /);
    expect(next).toBeGreaterThan(-1);
    const body = code.slice(start, start + 1 + next);
    expect(body).toContain('rpc("update_bundle_with_membership"');
    expect(body).not.toMatch(/\.(update|insert|delete|upsert)\(/);
    expect(body).not.toMatch(/from\("bundles"\)\s*\.(update|insert|delete|upsert)/);
    expect(body.match(/\.rpc\(/g)).toHaveLength(1);
  });

  it("no other application file writes bundle_books", () => {
    // Every writer outside tests: the staging-fixture tooling (service
    // role) is the only one, and it lives under scripts/, not src/.
    const srcRoot = path.resolve(__dirname, "../../../..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
          const text = readFileSync(full, "utf8").replace(/\/\/[^\n]*/g, "");
          if (/from\(\s*["']bundle_books["']\s*\)\s*\.(insert|delete|update|upsert)\(/.test(text)) offenders.push(full);
        }
      }
    };
    walk(srcRoot);
    expect(path.basename(srcRoot)).toBe("src");
    expect(offenders).toEqual([]);
  });
});
