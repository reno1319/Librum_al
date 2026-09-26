import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ALL-WIRING-5: createBundle/updateBundle price parsing and the exact
// write payloads. The subject is WHAT reaches the database and WHEN:
// every rejected price must cost zero bundle writes and zero
// bundle_books writes, and every accepted one must write `price_all`
// and never name `price_cents` at all.

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
vi.mock("@/lib/recovery-guard", () => ({ redirectIfRecoverySessionActive: vi.fn() }));

const USER_ID = "author-1";
const BUNDLE_ID = "bundle-1";
const BOOK_IDS = ["book-a", "book-b"];

// Every write this file can observe, in order, tagged by table and verb.
// BUNDLE-MEMBERSHIP-AUTH-1: the trusted membership writers are RPCs and
// are recorded with table = "rpc:<function>".
type Write = { table: string; op: "insert" | "update" | "delete" | "rpc"; payload?: unknown };
let writes: Write[] = [];
// PAID-REPRICING-1: updateBundle now reads `status` and `price_all` to
// decide whether the price change needs paid-publishing permission. The
// default is a draft, so every accepted price below may be saved; the
// published cases live in paid-repricing-guards.test.ts.
type ExistingBundle = { id: string; status: string; price_all: number | null };
const DRAFT_BUNDLE: ExistingBundle = { id: BUNDLE_ID, status: "draft", price_all: null };
let existingBundle: ExistingBundle | null = DRAFT_BUNDLE;
// null = echo the exact state the call asked for (the real writer's
// success shape); anything else is returned verbatim.
let rpcResult: { data: unknown; error: unknown } | null = null;
// Any session/catalog-writer `bundles` update is a regression since
// BUNDLE-MEMBERSHIP-AUTH-1: updateBundle saves through one RPC.
const bundleUpdateResult = { data: null, error: { message: "direct bundles update is not a Patch 13 path" } };

// A thenable builder: every filter returns itself; awaiting it resolves
// to `result`.
function thenable(result: unknown) {
  const chain: Record<string, unknown> = {};
  for (const method of ["eq", "is", "in", "select", "order"]) chain[method] = () => chain;
  chain.then = (onFulfilled: (v: unknown) => unknown) => Promise.resolve(result).then(onFulfilled);
  return chain;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  from: (table: string) => {
    if (table === "books") {
      // resolveBookSelection(): the author's own published books.
      return { select: () => thenable({ data: BOOK_IDS.map((id) => ({ id })) }) };
    }
    if (table === "bundles") {
      return {
        select: () => {
          const chain = { eq: () => chain, maybeSingle: async () => ({ data: existingBundle }) };
          return chain;
        },
        insert: (payload: unknown) => {
          // createBundle no longer inserts bundles on the session; any
          // regression is recorded here and refused.
          writes.push({ table, op: "insert", payload });
          return {
            select: () => ({
              single: async () => ({ data: null, error: { message: "session bundle insert is not a Patch 13 path" } }),
            }),
          };
        },
        update: (payload: unknown) => {
          writes.push({ table, op: "update", payload });
          return thenable(bundleUpdateResult);
        },
      };
    }
    if (table === "bundle_books") {
      // No action may write membership directly any more.
      return {
        insert: (payload: unknown) => {
          writes.push({ table, op: "insert", payload });
          return thenable({ error: null });
        },
        delete: () => {
          writes.push({ table, op: "delete" });
          return thenable({ error: null });
        },
      };
    }
    throw new Error(`unexpected table: ${table}`);
  },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    writes.push({ table: `rpc:${fn}`, op: "rpc", payload: args });
    if (rpcResult) return rpcResult;
    const ids = args.p_book_ids as string[];
    return {
      data: ids.map((id) => ({
        member_bundle_id: args.p_bundle_id,
        member_book_id: id,
        ...(fn === "update_bundle_with_membership"
          ? {
              bundle_title: args.p_title,
              bundle_description: args.p_description,
              bundle_price_all: args.p_price_all,
              bundle_status: existingBundle?.status ?? "draft",
            }
          : {}),
      })),
      error: null,
    };
  },
};
const mockCreateClient = vi.fn(async () => client);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
// CATALOG-WRITE-AUTH-1: the protected catalog writes go through
// createCatalogWriteClient(). This focused suite routes that client onto
// the same session double so its payload and filter assertions still see
// every write; WHICH client performs which write is pinned separately in
// dashboard/catalog-write-authorization.test.ts.
vi.mock("@/lib/catalog-write-client", async () => {
  const { catalogWriterReplayingOnto } = await import("@/lib/catalog-write-test-double");
  return { createCatalogWriteClient: () => catalogWriterReplayingOnto(() => mockCreateClient()) };
});

const { createBundle, updateBundle } = await import("./actions");

function form(price: unknown, overrides: { title?: string } = {}): FormData {
  const fd = new FormData();
  fd.set("title", overrides.title ?? "The Collection");
  fd.set("description", "Two books");
  if (price !== undefined) {
    // FormData coerces non-Blob values to strings, so a non-string input
    // has to arrive as a File -- which is exactly the non-string case a
    // crafted multipart POST can produce.
    fd.set("price", price as string | Blob);
  }
  for (const id of BOOK_IDS) fd.append("bookIds", id);
  return fd;
}

const PRICE_ERROR =
  "Enter the bundle price in lek: 0 for a free bundle, or a whole number from 99 to 100000";

// Accepted inputs and the whole-lek integer each must be stored as.
const ACCEPTED: Array<[string, number]> = [
  ["0", 0],
  ["0.00", 0],
  ["0,00", 0],
  ["99", 99],
  ["99.00", 99],
  ["99,00", 99],
  ["199", 199],
  ["  250  ", 250],
  ["00099", 99],
  ["100000", 100_000],
  ["100000,00", 100_000],
];

// Rejected inputs. Every one of these would have produced SOME row under
// the old `Math.round(Number(raw) * 100)`: empty -> 0 (free), "1e3" ->
// 100000 cents, "0.5" -> 50 cents, "-0" -> 0, "0x63" -> 9900.
const REJECTED: Array<[string, unknown]> = [
  ["empty", ""],
  ["whitespace only", "   "],
  ["1 (below the paid floor)", "1"],
  ["98 (below the paid floor)", "98"],
  ["100001 (above the ceiling)", "100001"],
  ["a fraction with a dot", "99.50"],
  ["a fraction with a comma", "98,99"],
  ["a one-digit fraction", "99.5"],
  ["a bare decimal", "0.5"],
  ["exponent notation", "1e3"],
  ["hexadecimal", "0x63"],
  ["a minus sign", "-199"],
  ["negative zero", "-0"],
  ["a plus sign", "+199"],
  ["comma grouping", "1,000"],
  ["dot grouping", "1.000"],
  ["mixed grouping", "1.234,56"],
  ["a currency symbol", "$25"],
  ["a currency suffix", "199 ALL"],
  ["Infinity", "Infinity"],
  ["NaN", "NaN"],
  ["a non-string File value", new File(["199"], "price.txt")],
];

beforeEach(() => {
  writes = [];
  existingBundle = DRAFT_BUNDLE;
  rpcResult = null;
  mockRedirect.mockClear();
  mockCreateClient.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("createBundle: canonical ALL price parsing (ALL-WIRING-5)", () => {
  it.each(ACCEPTED)("accepts %j and inserts price_all = %i", async (raw, expected) => {
    await expect(createBundle(form(raw))).rejects.toMatchObject({
      target: "/dashboard/bundles?success=Bundle+created+as+a+draft",
    });

    // BUNDLE-MEMBERSHIP-AUTH-1: the bundle row is inserted by
    // create_bundle_with_membership, together with its membership.
    expect(writes.map((w) => w.table)).toEqual(["rpc:create_bundle_with_membership"]);
    expect(writes[0].payload).toEqual({
      p_bundle_id: expect.any(String),
      p_author_id: USER_ID,
      p_title: "The Collection",
      p_description: "Two books",
      p_price_all: expected,
      p_book_ids: BOOK_IDS,
    });
  });

  it("the insert payload never names price_cents or status -- not even as 0 or 'draft'", async () => {
    await expect(createBundle(form("199"))).rejects.toBeInstanceOf(RedirectSignal);

    const payload = writes.find((w) => w.table === "rpc:create_bundle_with_membership")?.payload as Record<
      string,
      unknown
    >;
    expect(Object.keys(payload).sort()).toEqual([
      "p_author_id",
      "p_book_ids",
      "p_bundle_id",
      "p_description",
      "p_price_all",
      "p_title",
    ]);
    expect(payload.p_price_all).toBe(199);
    expect(Number.isInteger(payload.p_price_all)).toBe(true);
  });

  it.each(REJECTED)("rejects %s with the fixed message and performs no write at all", async (_label, raw) => {
    await expect(createBundle(form(raw))).rejects.toMatchObject({
      target: `/dashboard/bundles?error=${encodeURIComponent(PRICE_ERROR)}`,
    });
    expect(writes).toEqual([]);
  });

  it("a MISSING price field is rejected, never read as free", async () => {
    await expect(createBundle(form(undefined))).rejects.toMatchObject({
      target: `/dashboard/bundles?error=${encodeURIComponent(PRICE_ERROR)}`,
    });
    expect(writes).toEqual([]);
  });

  it("the rejection message never echoes what the author typed", async () => {
    await expect(createBundle(form("<b>1e3</b>"))).rejects.toBeInstanceOf(RedirectSignal);
    const target = decodeURIComponent(mockRedirect.mock.calls[0][0]);
    expect(target).not.toContain("1e3");
    expect(target).not.toContain("<b>");
  });

  it("existing validation is intact: a missing title is still refused before any write", async () => {
    await expect(createBundle(form("199", { title: "   " }))).rejects.toMatchObject({
      target: "/dashboard/bundles?error=Please+fill+in+every+field",
    });
    expect(writes).toEqual([]);
  });

  it("existing validation is intact: fewer than two books is still refused before any write", async () => {
    const fd = form("199");
    fd.delete("bookIds");
    fd.append("bookIds", "book-a");
    await expect(createBundle(fd)).rejects.toMatchObject({
      target: "/dashboard/bundles?error=Choose+at+least+2+books",
    });
    expect(writes).toEqual([]);
  });

  it("a database insert error is logged, not shown: the redirect carries a fixed message", async () => {
    rpcResult = {
      data: null,
      error: { code: "23514", message: 'violates check constraint "bundles_price_all_range_check"' },
    };

    await expect(createBundle(form("199"))).rejects.toBeInstanceOf(RedirectSignal);

    const target = decodeURIComponent(mockRedirect.mock.calls[0][0]);
    expect(target).toBe("/dashboard/bundles?error=Could not create the bundle. Please try again.");
    expect(writes.some((w) => w.table === "bundle_books")).toBe(false);
  });

  it("an error without a SQLSTATE is reported as unconfirmed, never as a clean failure", async () => {
    rpcResult = { data: null, error: { message: "TypeError: fetch failed", code: "" } };

    await expect(createBundle(form("199"))).rejects.toBeInstanceOf(RedirectSignal);

    const target = decodeURIComponent(mockRedirect.mock.calls[0][0]);
    expect(target).toBe(
      "/dashboard/bundles?error=We could not confirm whether the bundle was created. Check your bundles before trying again.",
    );
  });
});

describe("updateBundle: canonical ALL price parsing (ALL-WIRING-5)", () => {
  const EDIT = `/dashboard/bundles/${BUNDLE_ID}/edit`;

  it.each(ACCEPTED)("accepts %j and updates price_all = %i", async (raw, expected) => {
    await expect(updateBundle(BUNDLE_ID, form(raw))).rejects.toMatchObject({
      target: "/dashboard/bundles?success=Bundle+updated",
    });

    // BUNDLE-MEMBERSHIP-AUTH-1: details and membership are one RPC.
    expect(writes.map((w) => w.table)).toEqual(["rpc:update_bundle_with_membership"]);
    expect(writes[0].payload).toEqual({
      p_bundle_id: BUNDLE_ID,
      p_author_id: USER_ID,
      // PAID-REPRICING-1: a paid price on a draft is conditioned on the
      // row still being a draft; a free price has no condition.
      p_expected_status: expected === 0 ? null : "draft",
      p_check_expected_price_all: false,
      p_expected_price_all: null,
      p_title: "The Collection",
      p_description: "Two books",
      p_price_all: expected,
      p_book_ids: BOOK_IDS,
    });
  });

  it("the update payload never names price_cents, so an existing legacy value is left exactly as stored", async () => {
    await expect(updateBundle(BUNDLE_ID, form("199"))).rejects.toBeInstanceOf(RedirectSignal);

    const payload = writes.find((w) => w.table === "rpc:update_bundle_with_membership")?.payload as Record<
      string,
      unknown
    >;
    // The function writes exactly title, description and price_all; the
    // payload offers nothing else to write -- no price_cents, no status.
    expect(Object.keys(payload).sort()).toEqual([
      "p_author_id",
      "p_book_ids",
      "p_bundle_id",
      "p_check_expected_price_all",
      "p_description",
      "p_expected_price_all",
      "p_expected_status",
      "p_price_all",
      "p_title",
    ]);
  });

  it.each(REJECTED)(
    "rejects %s and performs no bundle update and no membership delete or insert",
    async (_label, raw) => {
      await expect(updateBundle(BUNDLE_ID, form(raw))).rejects.toMatchObject({
        target: `${EDIT}?error=${encodeURIComponent(PRICE_ERROR)}`,
      });
      expect(writes).toEqual([]);
    },
  );

  it("a MISSING price field is rejected, never read as free", async () => {
    await expect(updateBundle(BUNDLE_ID, form(undefined))).rejects.toMatchObject({
      target: `${EDIT}?error=${encodeURIComponent(PRICE_ERROR)}`,
    });
    expect(writes).toEqual([]);
  });

  it("ownership is still checked first: a bundle the author does not own gets no write, whatever the price", async () => {
    existingBundle = null;
    await expect(updateBundle(BUNDLE_ID, form("199"))).rejects.toMatchObject({
      target: "/dashboard/bundles",
    });
    expect(writes).toEqual([]);
  });

  it("a database error is logged, not shown, and reported as rolled back", async () => {
    rpcResult = { data: null, error: { code: "42501", message: "permission denied for table bundles" } };

    await expect(updateBundle(BUNDLE_ID, form("199"))).rejects.toBeInstanceOf(RedirectSignal);

    const target = decodeURIComponent(mockRedirect.mock.calls[0][0]);
    expect(target).toBe(`${EDIT}?error=Could not save the bundle, so nothing was changed. Please try again.`);
    expect(writes.map((w) => w.table)).toEqual(["rpc:update_bundle_with_membership"]);
  });

  it("a valid save is exactly one trusted RPC -- no separate bundles update, no direct membership write", async () => {
    await expect(updateBundle(BUNDLE_ID, form("0"))).rejects.toBeInstanceOf(RedirectSignal);

    expect(writes.map((w) => `${w.table}:${w.op}`)).toEqual(["rpc:update_bundle_with_membership:rpc"]);
  });
});

describe("price-writing bundle actions: maintenance gate precedes the parser and Supabase (ALL-WIRING-5)", () => {
  beforeEach(() => vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active"));

  it("createBundle with a VALID price refuses before any Supabase access", async () => {
    await expect(createBundle(form("199"))).rejects.toMatchObject({
      target: expect.stringContaining("/dashboard/bundles?error="),
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("updateBundle with a VALID price refuses before any Supabase access", async () => {
    await expect(updateBundle(BUNDLE_ID, form("199"))).rejects.toMatchObject({
      target: expect.stringContaining(`/dashboard/bundles/${BUNDLE_ID}/edit?error=`),
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });
});
