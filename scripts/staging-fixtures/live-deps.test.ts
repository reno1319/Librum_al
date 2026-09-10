// PHASE-1C review round 3, item 7: adapter-level tests for live-deps.mts
// using a MOCKED @supabase/supabase-js client -- every other test file in
// this directory (dispositions.test.ts, storage-keys.test.ts,
// auth-ownership.test.ts, seed.test.ts, reset.test.ts) exercises the pure
// orchestration logic against injected fakes and never touches
// live-deps.mts at all. This file is what actually exercises the adapter
// boundary itself: the real table/column names, the exact query shapes,
// and the error-propagation contract every Deps/SeedDeps function
// promises to its caller -- entirely without any network access or real
// credentials (the mocked client never makes an HTTP request).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STAGING_SUPABASE_PROJECT_REF, PRODUCTION_SUPABASE_PROJECT_REF } from "./guard.mts";
import { protectedTables, rpcOnlyProtectedTables } from "./dispositions.mts";
import { FIXTURE_BUNDLE_MEMBERSHIPS, FIXTURE_BUNDLE_ID } from "./manifest.mts";

// ============================================================
// A minimal, generic fake PostgREST/Storage/Auth client. Every
// `.from(table)...` call is recorded (table name + operation + every
// filter applied, in order) so a test can assert on the EXACT query
// shape issued -- not just "something was called". A per-test
// `resolver(table, description)` supplies the {data, error, count}
// result; the default resolver returns empty/success for anything not
// explicitly configured.
// ============================================================
type QueryDescription = {
  op?: "select" | "update" | "delete" | "upsert";
  select?: string;
  opts?: Record<string, unknown>;
  fields?: Record<string, unknown>;
  rows?: unknown;
  filters: { type: string; col?: string; val?: unknown; vals?: unknown; clause?: string; op?: string }[];
  single?: boolean;
};
type CallLogEntry = { table: string } & QueryDescription;
type Resolver = (table: string, description: QueryDescription) => { data?: unknown; error?: unknown; count?: number | null };

class FakeQueryBuilder implements PromiseLike<{ data?: unknown; error?: unknown; count?: number | null }> {
  private description: QueryDescription = { filters: [] };
  constructor(
    private table: string,
    private callLog: CallLogEntry[],
    private resolver: Resolver,
  ) {}
  select(cols?: string, opts?: Record<string, unknown>) {
    this.description.op ??= "select";
    this.description.select = cols;
    this.description.opts = opts;
    return this;
  }
  update(fields: Record<string, unknown>) {
    this.description.op = "update";
    this.description.fields = fields;
    return this;
  }
  delete() {
    this.description.op = "delete";
    return this;
  }
  upsert(rows: unknown, opts?: Record<string, unknown>) {
    this.description.op = "upsert";
    this.description.rows = rows;
    this.description.opts = opts;
    return this;
  }
  eq(col: string, val: unknown) {
    this.description.filters.push({ type: "eq", col, val });
    return this;
  }
  in(col: string, vals: unknown) {
    this.description.filters.push({ type: "in", col, vals });
    return this;
  }
  or(clause: string) {
    this.description.filters.push({ type: "or", clause });
    return this;
  }
  not(col: string, op: string, val: unknown) {
    this.description.filters.push({ type: "not", col, op, val });
    return this;
  }
  maybeSingle() {
    this.description.single = true;
    return this;
  }
  then<TResult1 = { data?: unknown; error?: unknown; count?: number | null }, TResult2 = never>(
    onfulfilled?: ((value: { data?: unknown; error?: unknown; count?: number | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.callLog.push({ table: this.table, ...this.description });
    const result = this.resolver(this.table, this.description);
    return Promise.resolve(result).then(onfulfilled, onrejected);
  }
}

function makeFakeClient(resolver: Resolver, callLog: CallLogEntry[]) {
  return {
    from: (table: string) => new FakeQueryBuilder(table, callLog, resolver),
    rpc: async (fnName: string, params: Record<string, unknown>) => {
      callLog.push({ table: `rpc:${fnName}`, filters: [], fields: params });
      return resolver(`rpc:${fnName}`, { filters: [], fields: params });
    },
    storage: {
      from: (bucket: string) => ({
        list: async (path: string, opts: Record<string, unknown>) => {
          callLog.push({ table: `storage:${bucket}:list`, filters: [], select: path, opts });
          return resolver(`storage:${bucket}:list`, { filters: [], select: path, opts });
        },
        info: async (key: string) => {
          callLog.push({ table: `storage:${bucket}:info`, filters: [], select: key });
          return resolver(`storage:${bucket}:info`, { filters: [], select: key });
        },
        upload: async (key: string) => {
          callLog.push({ table: `storage:${bucket}:upload`, filters: [], select: key });
          return resolver(`storage:${bucket}:upload`, { filters: [], select: key });
        },
        remove: async (keys: string[]) => {
          callLog.push({ table: `storage:${bucket}:remove`, filters: [], rows: keys });
          return resolver(`storage:${bucket}:remove`, { filters: [], rows: keys });
        },
      }),
    },
    auth: {
      admin: {
        listUsers: async (params: unknown) => {
          callLog.push({ table: "auth:listUsers", filters: [], rows: params });
          return resolver("auth:listUsers", { filters: [], rows: params });
        },
        getUserById: async (id: string) => {
          callLog.push({ table: "auth:getUserById", filters: [], select: id });
          return resolver("auth:getUserById", { filters: [], select: id });
        },
        deleteUser: async (id: string) => {
          callLog.push({ table: "auth:deleteUser", filters: [], select: id });
          return resolver("auth:deleteUser", { filters: [], select: id });
        },
        updateUserById: async (id: string, attrs: unknown) => {
          callLog.push({ table: "auth:updateUserById", filters: [], select: id, fields: attrs as Record<string, unknown> });
          return resolver("auth:updateUserById", { filters: [], select: id, fields: attrs as Record<string, unknown> });
        },
        createUser: async (attrs: unknown) => {
          callLog.push({ table: "auth:createUser", filters: [], fields: attrs as Record<string, unknown> });
          return resolver("auth:createUser", { filters: [], fields: attrs as Record<string, unknown> });
        },
      },
    },
  };
}

// ---- Module mock: @supabase/supabase-js ----
// PHASE-1C review round 4, item 3: live-deps.mts no longer imports
// "@supabase/storage-js" at all (it isn't a declared direct dependency
// of this repo) -- Storage not-found detection is a structural check
// against a plain Error's own `.status` field, so no corresponding
// mock is needed here either.
const { createClientMock, isAuthApiErrorMock } = vi.hoisted(() => ({
  createClientMock: vi.fn(),
  isAuthApiErrorMock: vi.fn((err: unknown) => Boolean(err) && typeof err === "object" && (err as { __isAuthApiError?: boolean }).__isAuthApiError === true),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: createClientMock,
  isAuthApiError: isAuthApiErrorMock,
}));

const AUTHOR_ID = "11111111-1111-4111-8111-111111111111";
const READER_ID = "22222222-2222-4222-8222-222222222222";

function defaultResolver(): { data: unknown[]; error: null; count: number } {
  return { data: [], error: null, count: 0 };
}

function setUpFakeClient(resolver: Resolver = defaultResolver): CallLogEntry[] {
  const callLog: CallLogEntry[] = [];
  const client = makeFakeClient(resolver, callLog);
  createClientMock.mockReset();
  createClientMock.mockReturnValue(client);
  return callLog;
}

const REAL_ENV = { ...process.env };
beforeEach(() => {
  process.env.STAGING_FIXTURE_SUPABASE_URL = `https://${STAGING_SUPABASE_PROJECT_REF}.supabase.co`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key-not-real";
  process.env.STAGING_FIXTURE_AUTHOR_PASSWORD = "fake-author-password-not-real";
  process.env.STAGING_FIXTURE_READER_PASSWORD = "fake-reader-password-not-real";
});
afterEach(() => {
  process.env = { ...REAL_ENV };
  vi.resetModules();
});

// PHASE-1C review round 4, item 3's required regression test: "add a
// runtime import/adapter smoke test." This module (live-deps.mts) was
// changed to import ONLY from "@supabase/supabase-js" -- never
// "@supabase/storage-js" directly, even though that package is
// currently present in node_modules as a transitive dependency -- so
// this file's own successful import (every test below already depends
// on `await import("./live-deps.mts")` succeeding) is itself a
// standing smoke test of that fix on every run. This describe block
// makes that assertion explicit and adds the one thing the ambient
// tests don't already cover: that every exported adapter builder is
// actually present and callable, confirming the module's own shape is
// intact end to end.
//
// This was ALSO verified from a genuinely clean install (round 4's
// review requirement): `npm ci` in a disposable git worktree checked
// out at this PHASE-1C work's base commit, with the current
// scripts/staging-fixtures/ files copied in -- 530 packages installed
// with zero errors, then this exact test file (162 tests) passed
// against that fresh node_modules, and a standalone
// `node --experimental-strip-types` smoke import of live-deps.mts
// succeeded there too. See PHASE-1C's round-5 REVIEW-REPORT.txt for the
// full transcript; not repeatable inside this vitest run itself since
// it requires shelling out to a separate `npm ci`.
describe("runtime import/adapter smoke test (round 4, item 3)", () => {
  it("live-deps.mts imports successfully and exposes both adapter builders as callable functions", async () => {
    setUpFakeClient();
    const liveDeps = await import("./live-deps.mts");
    expect(typeof liveDeps.buildLiveSeedDeps).toBe("function");
    expect(typeof liveDeps.buildLiveResetDeps).toBe("function");
    // Constructing both must not throw, given valid env vars.
    expect(() => liveDeps.buildLiveSeedDeps()).not.toThrow();
    expect(() => liveDeps.buildLiveResetDeps()).not.toThrow();
  });
});

// Property 9: no mutation before complete discovery/validation/
// confirmation -- verified here as "constructing the Deps object makes
// ZERO calls into the underlying client; every call happens only when
// an individual Deps function is actually invoked, on demand."
describe("property 9: buildLiveResetDeps/buildLiveSeedDeps perform zero client calls at construction time", () => {
  it("buildLiveResetDeps calls createClient but issues no query/storage/auth call until a Deps function runs", async () => {
    const callLog = setUpFakeClient();
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    buildLiveResetDeps();
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual([]);
  });

  it("buildLiveSeedDeps calls createClient but issues no query/storage/auth call until a Deps function runs", async () => {
    const callLog = setUpFakeClient();
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    buildLiveSeedDeps();
    expect(createClientMock).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual([]);
  });

  it("never even calls createClient when the staging guard rejects the target", async () => {
    setUpFakeClient();
    process.env.STAGING_FIXTURE_SUPABASE_URL = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    expect(() => buildLiveResetDeps()).toThrow();
    expect(createClientMock).not.toHaveBeenCalled();
  });
});

// Property 1: real table/column names -- traced directly against
// supabase/schema.sql, not memory.
describe("property 1: real table/column names", () => {
  it("discoverFixtureLinkedRowIds('books', ctx) queries books.author_id", async () => {
    const callLog = setUpFakeClient();
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await deps.discoverFixtureLinkedRowIds("books", { authorId: AUTHOR_ID, readerId: READER_ID });
    const call = callLog.find((c) => c.table === "books");
    expect(call).toBeDefined();
    expect(call!.filters).toContainEqual({ type: "eq", col: "author_id", val: AUTHOR_ID });
  });

  it("getProfileExternalState selects the real avatar_path/stripe_account_id/stripe_payouts_enabled columns from profiles", async () => {
    const callLog = setUpFakeClient(() => ({ data: { avatar_path: null, stripe_account_id: null, stripe_payouts_enabled: false }, error: null }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await deps.getProfileExternalState(AUTHOR_ID);
    const call = callLog.find((c) => c.table === "profiles");
    expect(call?.select).toBe("avatar_path, stripe_account_id, stripe_payouts_enabled");
    expect(call?.filters).toContainEqual({ type: "eq", col: "id", val: AUTHOR_ID });
  });

  // PHASE-1C review round 3, item 1: bundle_checkout_reservations has
  // ONLY id, snapshot_id, book_id, created_at (confirmed against
  // schema.sql) -- it must be queried by book_id alone, never grouped
  // with a reader_id filter the table doesn't have a column for.
  it("discoverFixtureLinkedRowIds('bundle_checkout_reservations', ctx) filters by book_id only, never reader_id", async () => {
    const callLog = setUpFakeClient((table) =>
      table === "books" ? { data: [{ id: "book-1" }], error: null } : { data: [], error: null },
    );
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await deps.discoverFixtureLinkedRowIds("bundle_checkout_reservations", { authorId: AUTHOR_ID, readerId: READER_ID });
    const call = callLog.find((c) => c.table === "bundle_checkout_reservations");
    expect(call).toBeDefined();
    for (const filter of call!.filters) {
      expect(filter.col).not.toBe("reader_id");
      if (filter.clause) expect(filter.clause).not.toContain("reader_id");
    }
    expect(call!.filters.some((f) => f.type === "in" && f.col === "book_id")).toBe(true);
  });
});

// Property 2: query-error propagation -- a real query failure must
// never be silently converted into "no rows" / "zero" / "absent".
describe("property 2: query-error propagation", () => {
  it("discoverFixtureLinkedRowIds propagates a books lookup error rather than defaulting to []", async () => {
    setUpFakeClient((table) => (table === "books" ? { data: null, error: new Error("boom: books unreachable") } : { data: [], error: null }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await expect(deps.discoverFixtureLinkedRowIds("reviews", { authorId: AUTHOR_ID, readerId: READER_ID })).rejects.toThrow(/boom/);
  });

  it("countRowsMatchingTraversal propagates a genuine query error rather than returning 0", async () => {
    setUpFakeClient((table) => (table === "payments" ? { data: null, error: new Error("boom: payments unreachable"), count: null } : { data: [], error: null, count: 0 }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await expect(deps.countRowsMatchingTraversal("payments", { authorId: AUTHOR_ID, readerId: READER_ID })).rejects.toThrow(/boom/);
  });

  it("deleteByIds propagates a delete error", async () => {
    setUpFakeClient(() => ({ data: null, error: new Error("boom: delete failed") }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await expect(deps.deleteByIds("books", ["id-1"])).rejects.toThrow(/boom/);
  });
});

// Property 3: protected-table coverage -- every protectedTables() entry
// must have a real, working query mapping (never fall through to the
// "no mapping implemented" default, which would be a silent gap in
// preflight's safety net) -- including the 3 zero-grant payout tables,
// which route through the RPC instead of a direct REST count.
describe("property 3: protected-table coverage", () => {
  it("every protectedTables() table has a working countRowsMatchingTraversal mapping", async () => {
    setUpFakeClient(() => ({
      data: [
        { table_name: "author_payout_destinations", row_count: 0 },
        { table_name: "payout_destination_snapshots", row_count: 0 },
        { table_name: "payout_reversal", row_count: 0 },
      ],
      error: null,
      count: 0,
    }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    for (const table of protectedTables("resetToBaseline")) {
      await expect(
        deps.countRowsMatchingTraversal(table, { authorId: AUTHOR_ID, readerId: READER_ID }),
        `expected "${table}" to have a working query mapping`,
      ).resolves.toBe(0);
    }
  });

  // PHASE-1C review round 4, item 4's required regression test: "Verify
  // the count-only protected-table mechanism and its privileges" -- at
  // the adapter level, this proves the 3 zero-grant tables are counted
  // via `.rpc("staging_fixture_protected_table_counts", {p_author_id})`,
  // never a direct `.from(table)` REST count (which would fail with a
  // permission error against the real, zero-grant tables).
  describe("RPC-only protected tables route through staging_fixture_protected_table_counts (round 4, item 4)", () => {
    it("calls the RPC with p_author_id, never a direct .from() count, for each RPC-only table", async () => {
      const callLog = setUpFakeClient((_table, desc) => {
        if (desc.fields && "p_author_id" in desc.fields) {
          return {
            data: [
              { table_name: "author_payout_destinations", row_count: 3 },
              { table_name: "payout_destination_snapshots", row_count: 5 },
              { table_name: "payout_reversal", row_count: 7 },
            ],
            error: null,
          };
        }
        return { data: [], error: null, count: 0 };
      });
      const { buildLiveResetDeps } = await import("./live-deps.mts");
      const deps = buildLiveResetDeps();
      const expected: Record<string, number> = {
        author_payout_destinations: 3,
        payout_destination_snapshots: 5,
        payout_reversal: 7,
      };
      for (const table of rpcOnlyProtectedTables("resetToBaseline")) {
        const count = await deps.countRowsMatchingTraversal(table, { authorId: AUTHOR_ID, readerId: READER_ID });
        expect(count).toBe(expected[table]);
      }
      const rpcCall = callLog.find((c) => c.table === "rpc:staging_fixture_protected_table_counts");
      expect(rpcCall).toBeDefined();
      expect(rpcCall?.fields).toEqual({ p_author_id: AUTHOR_ID });
      // Never a direct REST count against any of the 3 real tables --
      // that would fail with a permission error against the zero-grant
      // tables in reality.
      for (const table of rpcOnlyProtectedTables("resetToBaseline")) {
        expect(callLog.some((c) => c.table === table)).toBe(false);
      }
    });

    it("propagates an RPC error rather than treating it as a trustworthy zero", async () => {
      setUpFakeClient(() => ({ data: null, error: new Error("boom: RPC failed") }));
      const { buildLiveResetDeps } = await import("./live-deps.mts");
      const deps = buildLiveResetDeps();
      await expect(
        deps.countRowsMatchingTraversal("payout_reversal", { authorId: AUTHOR_ID, readerId: READER_ID }),
      ).rejects.toThrow(/boom/);
    });
  });

  // PHASE-1C review round 5, item 4's required regression coverage:
  // "Validate that the count RPC returns exactly the three expected
  // unique table names and that every count is a finite, nonnegative
  // integer. Reject missing, duplicate, unexpected, null, NaN,
  // fractional, or negative values."
  describe("RPC response validation (round 5, item 4)", () => {
    const ALL_THREE_ZERO = [
      { table_name: "author_payout_destinations", row_count: 0 },
      { table_name: "payout_destination_snapshots", row_count: 0 },
      { table_name: "payout_reversal", row_count: 0 },
    ];

    async function callWith(data: unknown) {
      setUpFakeClient((_table, desc) =>
        desc.fields && "p_author_id" in desc.fields ? { data, error: null } : { data: [], error: null, count: 0 },
      );
      const { buildLiveResetDeps } = await import("./live-deps.mts");
      const deps = buildLiveResetDeps();
      return deps.countRowsMatchingTraversal("payout_reversal", { authorId: AUTHOR_ID, readerId: READER_ID });
    }

    it("accepts exactly the 3 expected rows with valid nonnegative integer counts", async () => {
      await expect(callWith(ALL_THREE_ZERO)).resolves.toBe(0);
    });

    it("accepts a Postgres-bigint-shaped numeric string count", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: "0" },
          { table_name: "payout_destination_snapshots", row_count: "0" },
          { table_name: "payout_reversal", row_count: "42" },
        ]),
      ).resolves.toBe(42);
    });

    it("rejects a response missing one of the 3 expected rows", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
        ]),
      ).rejects.toThrow(/missing/i);
    });

    it("rejects a duplicate row for the same table_name", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "payout_reversal", row_count: 0 },
        ]),
      ).rejects.toThrow(/duplicate/i);
    });

    it("rejects a row with an unexpected/unknown table_name", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "some_other_table_entirely", row_count: 0 },
        ]),
      ).rejects.toThrow(/unexpected table_name/i);
    });

    it("rejects a null row_count", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "payout_reversal", row_count: null },
        ]),
      ).rejects.toThrow(/row_count/);
    });

    it("rejects a NaN-producing (non-numeric string) row_count", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "payout_reversal", row_count: "not-a-number" },
        ]),
      ).rejects.toThrow(/row_count/);
    });

    it("rejects a fractional row_count", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "payout_reversal", row_count: 1.5 },
        ]),
      ).rejects.toThrow(/row_count/);
    });

    it("rejects a negative row_count", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "payout_reversal", row_count: -1 },
        ]),
      ).rejects.toThrow(/row_count/);
    });

    it("rejects an Infinity row_count", async () => {
      await expect(
        callWith([
          { table_name: "author_payout_destinations", row_count: 0 },
          { table_name: "payout_destination_snapshots", row_count: 0 },
          { table_name: "payout_reversal", row_count: Number.POSITIVE_INFINITY },
        ]),
      ).rejects.toThrow(/row_count/);
    });

    it("rejects a non-array response entirely", async () => {
      await expect(callWith({ not: "an array" })).rejects.toThrow(/expected an array/i);
    });

    it("rejects a malformed (non-object) row", async () => {
      await expect(callWith(["not-an-object", ...ALL_THREE_ZERO])).rejects.toThrow(/malformed row/i);
    });
  });

  // PHASE-1C review round 3, item 3: payment_disputes must join through
  // the fixture-linked purchases' OWN real stripe_payment_intent_id
  // values, never a hardcoded hit-or-zero placeholder.
  it("payment_disputes counts via a real join through fixture-linked purchases, not a hardcoded value", async () => {
    setUpFakeClient((table, desc) => {
      if (table === "purchases" && desc.select === "stripe_payment_intent_id") {
        return { data: [{ stripe_payment_intent_id: "pi_real_dispute_linked" }], error: null };
      }
      if (table === "payment_disputes") {
        expect(desc.filters).toContainEqual({ type: "in", col: "stripe_payment_intent_id", vals: ["pi_real_dispute_linked"] });
        return { data: [], error: null, count: 2 };
      }
      return { data: [], error: null, count: 0 };
    });
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    const count = await deps.countRowsMatchingTraversal("payment_disputes", { authorId: AUTHOR_ID, readerId: READER_ID });
    expect(count).toBe(2);
  });
});

// Property 4: exact-ID deletion scopes -- deleteByIds must issue an
// `.in("id", ids)` delete and nothing broader (never re-derives an
// owner-based match at delete time).
describe("property 4: exact-ID deletion scopes", () => {
  it("deleteByIds issues delete().in('id', ids) with no other filter", async () => {
    const callLog = setUpFakeClient(() => ({ data: [{ id: "a" }, { id: "b" }], error: null }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await deps.deleteByIds("reviews", ["a", "b"]);
    const call = callLog.find((c) => c.table === "reviews");
    expect(call?.op).toBe("delete");
    expect(call?.filters).toEqual([{ type: "in", col: "id", vals: ["a", "b"] }]);
  });
});

// Property 5: immutable-plan enforcement, adapter side -- deleteByIds
// given an EMPTY id list must issue zero client calls at all (the
// caller froze "nothing to delete here"; the adapter must not go query
// for something to delete on its own).
describe("property 5: immutable-plan enforcement (adapter never expands an empty frozen target)", () => {
  it("deleteByIds with an empty id array makes zero client calls", async () => {
    const callLog = setUpFakeClient();
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    const result = await deps.deleteByIds("books", []);
    expect(result).toEqual({ deletedCount: 0 });
    expect(callLog).toEqual([]);
  });
});

// Property 6: correct postconditions after reseeding -- the SAME
// discoverFixtureLinkedRowIds function reset.mts's postcondition check
// calls must accurately reflect whatever rows the fake "database"
// currently reports, mapped to plain id strings.
describe("property 6: discoverFixtureLinkedRowIds accurately reports current row ids (postcondition contract)", () => {
  it("maps returned rows to their id strings, table by table", async () => {
    setUpFakeClient((table) => {
      if (table === "series") return { data: [{ id: "series-1" }], error: null };
      return { data: [], error: null };
    });
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    const ids = await deps.discoverFixtureLinkedRowIds("series", { authorId: AUTHOR_ID, readerId: READER_ID });
    expect(ids).toEqual(["series-1"]);
  });
});

// Property 7: both users' Storage namespaces -- listStorageEntries must
// pass the bucket/path through unchanged for ANY namespace root, not
// hardcode the author's id.
describe("property 7: Storage works for either fixture account's own namespace", () => {
  it("listStorageEntries lists under the exact path given, for the reader's own id", async () => {
    const callLog = setUpFakeClient((table) =>
      table === `storage:avatars:list` ? { data: [{ name: "avatar.png", id: "obj-1", metadata: { size: 99 } }], error: null } : { data: [], error: null },
    );
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    const entries = await deps.listStorageEntries("avatars", READER_ID, { limit: 100, offset: 0 });
    expect(entries).toEqual([{ name: "avatar.png", id: "obj-1", metadata: { size: 99 } }]);
    const call = callLog.find((c) => c.table === "storage:avatars:list");
    expect(call?.select).toBe(READER_ID);
  });

  // PHASE-1C review round 4, item 2: the reader's temp avatar is staged
  // in the MANUSCRIPTS bucket, not avatars -- listStorageEntries must
  // work identically for that bucket/path combination too.
  it("listStorageEntries lists under the reader's manuscripts-bucket tmp/avatar path", async () => {
    const callLog = setUpFakeClient((table) =>
      table === "storage:manuscripts:list"
        ? { data: [{ name: "9f2c-uuid.png", id: "obj-2", metadata: { size: 2048 } }], error: null }
        : { data: [], error: null },
    );
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    const entries = await deps.listStorageEntries("manuscripts", `${READER_ID}/tmp/avatar`, { limit: 100, offset: 0 });
    expect(entries).toEqual([{ name: "9f2c-uuid.png", id: "obj-2", metadata: { size: 2048 } }]);
    const call = callLog.find((c) => c.table === "storage:manuscripts:list");
    expect(call?.select).toBe(`${READER_ID}/tmp/avatar`);
  });

  it("SeedDeps.verifyObjectSize reports the real size for a manuscript key", async () => {
    setUpFakeClient((table) => (table === "storage:manuscripts:info" ? { data: { size: 4096 }, error: null } : { data: [], error: null }));
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    const result = await deps.verifyObjectSize("manuscripts", `${AUTHOR_ID}/book-1.epub`);
    expect(result).toEqual({ sizeBytes: 4096 });
  });
});

// A structural stand-in for a real @supabase/storage-js StorageApiError
// -- a genuine Error instance carrying the same `status`/`statusCode`
// fields the real class would, WITHOUT importing that class (matching
// live-deps.mts's own round-4 structural-check approach, never the
// library's own StorageApiError/isStorageError helpers).
function makeStorageApiErrorLike(status: number, message: string): Error {
  return Object.assign(new Error(message), { status, statusCode: String(status) });
}

// PHASE-1C review round 4, item 3's required regression test:
// "Distinguish Storage 404 from 401/403/500/network failures."
describe("Storage .info() error semantics (round 4, item 3)", () => {
  it("treats a genuine StorageApiError-shaped error with status 404 as absent (null)", async () => {
    setUpFakeClient((table) =>
      table === "storage:covers:info" ? { data: null, error: makeStorageApiErrorLike(404, "not found") } : { data: [], error: null },
    );
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    await expect(deps.verifyObjectSize("covers", "some/key.png")).resolves.toEqual({ sizeBytes: null });
  });

  it("propagates a 401/403-shaped error rather than treating it as absent", async () => {
    setUpFakeClient((table) =>
      table === "storage:covers:info" ? { data: null, error: makeStorageApiErrorLike(403, "Forbidden") } : { data: [], error: null },
    );
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    await expect(deps.verifyObjectSize("covers", "some/key.png")).rejects.toBeTruthy();
  });

  it("propagates a 500-shaped error rather than treating it as absent", async () => {
    setUpFakeClient((table) =>
      table === "storage:covers:info" ? { data: null, error: makeStorageApiErrorLike(500, "Internal Server Error") } : { data: [], error: null },
    );
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    await expect(deps.verifyObjectSize("covers", "some/key.png")).rejects.toBeTruthy();
  });

  // A plain object (not an Error instance) with status 404 must NOT be
  // treated as absent -- the structural check requires `instanceof
  // Error` too, precisely to exclude an unrelated object that merely
  // happens to carry a `.status` field.
  it("propagates a non-Error object that merely happens to carry status:404, rather than treating it as absent", async () => {
    setUpFakeClient((table) =>
      table === "storage:covers:info" ? { data: null, error: { status: 404, message: "not a real error instance" } } : { data: [], error: null },
    );
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    await expect(deps.verifyObjectSize("covers", "some/key.png")).rejects.toBeTruthy();
  });

  it("propagates a plain network failure (not a StorageError at all) rather than treating it as absent", async () => {
    setUpFakeClient((table) =>
      table === "storage:covers:info" ? { data: null, error: new Error("network unreachable") } : { data: [], error: null },
    );
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    await expect(deps.verifyObjectSize("covers", "some/key.png")).rejects.toThrow(/network unreachable/);
  });
});

// Property 8: Auth lookup error handling -- distinguishes a genuine
// "user not found" signal from every other kind of failure.
describe("property 8: getUserById distinguishes genuine absence from a real error", () => {
  it("returns null only for AuthApiError with code 'user_not_found'", async () => {
    setUpFakeClient((table) =>
      table === "auth:getUserById" ? { data: { user: null }, error: { __isAuthApiError: true, code: "user_not_found", message: "not found" } } : { data: [], error: null },
    );
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await expect(deps.getUserById(AUTHOR_ID)).resolves.toBeNull();
  });

  it("propagates any other error (network/permission/500) rather than treating it as absence", async () => {
    setUpFakeClient((table) =>
      table === "auth:getUserById" ? { data: { user: null }, error: { __isAuthApiError: true, code: "unexpected_failure", message: "server exploded" } } : { data: [], error: null },
    );
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await expect(deps.getUserById(AUTHOR_ID)).rejects.toBeTruthy();
  });

  it("propagates a non-AuthApiError (e.g. a plain network failure) too", async () => {
    setUpFakeClient((table) => (table === "auth:getUserById" ? { data: { user: null }, error: new Error("network unreachable") } : { data: [], error: null }));
    const { buildLiveResetDeps } = await import("./live-deps.mts");
    const deps = buildLiveResetDeps();
    await expect(deps.getUserById(AUTHOR_ID)).rejects.toThrow(/network unreachable/);
  });

  it("returns the resolved user when found, for both seed and reset wiring", async () => {
    setUpFakeClient((table) => (table === "auth:getUserById" ? { data: { user: { id: AUTHOR_ID, email: "x", app_metadata: {}, last_sign_in_at: null } }, error: null } : { data: [], error: null }));
    const { buildLiveResetDeps, buildLiveSeedDeps } = await import("./live-deps.mts");
    // reset.mts's Deps.getUserById needs the full FixtureAuthUser (it
    // re-verifies app_metadata/last_sign_in_at); seed.mts's SeedDeps
    // only needs existence -- both must resolve to a non-null match on
    // the requested id, whatever shape each contract asks for.
    await expect(buildLiveResetDeps().getUserById(AUTHOR_ID)).resolves.toEqual(
      expect.objectContaining({ id: AUTHOR_ID }),
    );
    await expect(buildLiveSeedDeps().getUserById(AUTHOR_ID)).resolves.toEqual(
      expect.objectContaining({ id: AUTHOR_ID }),
    );
  });
});

// PHASE-1C review round 4, item 1's required regression test: "Assert
// the live bundle_books payload contains the manifest's fixed IDs" --
// proves the real adapter's upsert payload includes each membership's
// OWN fixed id, not merely a bundle-to-book pair a real database would
// have to default a fresh gen_random_uuid() for.
describe("SeedDeps.upsertBundleBooks includes the manifest's fixed membership ids (round 4, item 1)", () => {
  it("upserts rows carrying each membership's own fixed id, keyed on (bundle_id, book_id)", async () => {
    const callLog = setUpFakeClient(() => ({ data: [], error: null }));
    const { buildLiveSeedDeps } = await import("./live-deps.mts");
    const deps = buildLiveSeedDeps();
    await deps.upsertBundleBooks(FIXTURE_BUNDLE_ID, FIXTURE_BUNDLE_MEMBERSHIPS);
    const call = callLog.find((c) => c.table === "bundle_books");
    expect(call).toBeDefined();
    expect(call?.op).toBe("upsert");
    expect(call?.opts).toEqual({ onConflict: "bundle_id,book_id" });
    const rows = call?.rows as { id: string; bundle_id: string; book_id: string }[];
    expect(rows).toHaveLength(FIXTURE_BUNDLE_MEMBERSHIPS.length);
    for (const membership of FIXTURE_BUNDLE_MEMBERSHIPS) {
      expect(rows).toContainEqual({ id: membership.id, bundle_id: FIXTURE_BUNDLE_ID, book_id: membership.bookId });
    }
    // Exercises the exact regression this finding described: a payload
    // missing `id` would let Postgres default gen_random_uuid() on
    // first insert, silently diverging from baselineTableRowIds()'s
    // expectation on every subsequent run.
    expect(rows.every((r) => typeof r.id === "string" && r.id.length > 0)).toBe(true);
  });
});
