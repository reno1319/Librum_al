import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RIGHTS_STATEMENTS } from "./rights-statements";
import { resetSchemaFeatureOffLogForTests } from "./schema-feature-off";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: recordRightsDeclaration and
// getCurrentRightsDeclaration against fake session and service-role
// clients that record every call. The session client answers the
// ownership and profile reads (and the declaration read); the
// service-role client receives the one insert.

type Result = { data: unknown; error: { code?: string; message?: string } | null };
type Call = { table: string; method: string; args: unknown[] };

function fakeClient(results: Record<string, Result>, calls: Call[], user: { id: string } | null = null) {
  return {
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user } })) },
    from(table: string) {
      const builder: Record<string, (...args: unknown[]) => unknown> = {};
      for (const method of ["select", "eq", "order", "limit", "insert", "not"]) {
        builder[method] = (...args: unknown[]) => {
          calls.push({ table, method, args });
          return builder;
        };
      }
      const finish = () => Promise.resolve(results[table] ?? { data: null, error: null });
      builder.maybeSingle = () => {
        calls.push({ table, method: "maybeSingle", args: [] });
        return finish();
      };
      builder.single = () => {
        calls.push({ table, method: "single", args: [] });
        return finish();
      };
      return builder;
    },
  };
}

const AUTHOR = "a0000000-0000-4000-8000-00000000000a";
const BOOK = "b0000000-0000-4000-8000-000000000001";

let sessionCalls: Call[];
let adminCalls: Call[];
let sessionResults: Record<string, Result>;
let adminResults: Record<string, Result>;
let sessionUser: { id: string } | null;
let adminCreated: number;

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(fakeClient(sessionResults, sessionCalls, sessionUser)),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminCreated += 1;
    return fakeClient(adminResults, adminCalls);
  },
}));

const { recordRightsDeclaration, getCurrentRightsDeclaration, getRightsDeclarationState } = await import(
  "./book-rights"
);

const STORED = {
  id: "d0000000-0000-4000-8000-000000000001",
  book_id: BOOK,
  book_title: "Libri im",
  author_id: AUTHOR,
  author_public_name: "Arben Leka",
  basis: "own_rights",
  statement_version: "rights-v1",
  statement_text: RIGHTS_STATEMENTS.own_rights.text,
  declared_at: "2026-10-18T08:00:00+00:00",
};

beforeEach(() => {
  sessionCalls = [];
  adminCalls = [];
  adminCreated = 0;
  sessionUser = { id: AUTHOR };
  sessionResults = {
    books: { data: { id: BOOK, title: "Libri im" }, error: null },
    profiles: { data: { display_name: "Renato Kalemi", public_author_name: "Arben Leka" }, error: null },
  };
  adminResults = { book_rights_declarations: { data: STORED, error: null } };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  resetSchemaFeatureOffLogForTests();
  vi.restoreAllMocks();
});

const inserted = () => adminCalls.filter((c) => c.method === "insert").map((c) => c.args[0] as Record<string, unknown>);

describe("recordRightsDeclaration", () => {
  it("records the owner's choice with server-side values only", async () => {
    const result = await recordRightsDeclaration(BOOK, "own_rights");
    expect(result).toEqual({ ok: true, declaration: STORED });
    expect(inserted()).toEqual([
      {
        book_id: BOOK,
        book_title: "Libri im",
        author_id: AUTHOR,
        author_public_name: "Arben Leka",
        basis: "own_rights",
        statement_version: "rights-v1",
        statement_text: RIGHTS_STATEMENTS.own_rights.text,
      },
    ]);
    expect(adminCalls[0].table).toBe("book_rights_declarations");
  });

  it("checks ownership with the session client, by book id AND the signed-in author", async () => {
    await recordRightsDeclaration(BOOK, "public_domain");
    const bookEqs = sessionCalls.filter((c) => c.table === "books" && c.method === "eq").map((c) => c.args);
    expect(bookEqs).toEqual([
      ["id", BOOK],
      ["author_id", AUTHOR],
    ]);
    const profileEqs = sessionCalls.filter((c) => c.table === "profiles" && c.method === "eq").map((c) => c.args);
    expect(profileEqs).toEqual([["id", AUTHOR]]);
    expect(inserted()[0].statement_text).toBe(RIGHTS_STATEMENTS.public_domain.text);
    expect(inserted()[0].basis).toBe("public_domain");
  });

  it("not the owner (no owned row) -> refused, nothing inserted, no service-role client", async () => {
    sessionResults.books = { data: null, error: null };
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "not_owner" });
    expect(adminCreated).toBe(0);
    expect(inserted()).toEqual([]);
  });

  it("signed out -> refused before any read", async () => {
    sessionUser = null;
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "unauthenticated" });
    expect(sessionCalls).toEqual([]);
    expect(adminCreated).toBe(0);
  });

  it("a client-sent sentence is ignored: the stored text always comes from RIGHTS_STATEMENTS", async () => {
    const forged = "I may publish anything";
    const call = recordRightsDeclaration as unknown as (b: string, basis: unknown, text: string) => Promise<unknown>;
    await call(BOOK, "own_rights", forged);
    expect(inserted()[0].statement_text).toBe(RIGHTS_STATEMENTS.own_rights.text);
    expect(JSON.stringify(inserted())).not.toContain(forged);
  });

  it.each([RIGHTS_STATEMENTS.own_rights.text, "", "Own_rights", "own_rights ", null, undefined, 1, { basis: "own_rights" }])(
    "basis %j is refused before anything else runs",
    async (basis) => {
      expect(await recordRightsDeclaration(BOOK, basis)).toEqual({ ok: false, reason: "invalid_basis" });
      expect(sessionCalls).toEqual([]);
      expect(adminCreated).toBe(0);
    },
  );

  it("no author name (no profile row loaded) -> refused instead of a NOT NULL error", async () => {
    sessionResults.profiles = { data: null, error: null };
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "no_author_name" });
    expect(adminCreated).toBe(0);
  });

  it("falls back to display_name when there is no public author name", async () => {
    sessionResults.profiles = { data: { display_name: "Renato Kalemi", public_author_name: null }, error: null };
    await recordRightsDeclaration(BOOK, "own_rights");
    expect(inserted()[0].author_public_name).toBe("Renato Kalemi");
  });

  it("a failed ownership or profile read is an error, not a refusal to the wrong reason", async () => {
    sessionResults.books = { data: null, error: { code: "08006", message: "connection" } };
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "error" });
    sessionResults.books = { data: { id: BOOK, title: "Libri im" }, error: null };
    sessionResults.profiles = { data: null, error: { code: "08006", message: "connection" } };
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "error" });
    expect(adminCreated).toBe(0);
  });

  it.each(["42P01", "PGRST205", "42703", "PGRST204"])("before the migration (%s) -> feature_off, no throw", async (code) => {
    adminResults.book_rights_declarations = { data: null, error: { code, message: "missing" } };
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "feature_off" });
  });

  it("feature off is logged once, not per call", async () => {
    adminResults.book_rights_declarations = { data: null, error: { code: "PGRST205", message: "missing" } };
    await recordRightsDeclaration(BOOK, "own_rights");
    await recordRightsDeclaration(BOOK, "own_rights");
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("any other insert error -> error", async () => {
    adminResults.book_rights_declarations = { data: null, error: { code: "42501", message: "denied" } };
    expect(await recordRightsDeclaration(BOOK, "own_rights")).toEqual({ ok: false, reason: "error" });
  });
});

describe("getCurrentRightsDeclaration", () => {
  it("reads the newest row for the book with the session client", async () => {
    sessionResults.book_rights_declarations = { data: STORED, error: null };
    expect(await getCurrentRightsDeclaration(BOOK)).toEqual(STORED);
    const reads = sessionCalls.filter((c) => c.table === "book_rights_declarations");
    expect(reads.map((c) => [c.method, ...c.args])).toEqual([
      ["select", "*"],
      ["eq", "book_id", BOOK],
      ["order", "declared_at", { ascending: false }],
      ["order", "id", { ascending: false }],
      ["limit", 1],
      ["maybeSingle"],
    ]);
    expect(adminCreated).toBe(0);
  });

  it("no declaration -> null", async () => {
    sessionResults.book_rights_declarations = { data: null, error: null };
    expect(await getCurrentRightsDeclaration(BOOK)).toBeNull();
  });

  it("signed out -> null without a query", async () => {
    sessionUser = null;
    expect(await getCurrentRightsDeclaration(BOOK)).toBeNull();
    expect(sessionCalls).toEqual([]);
  });

  it.each(["42P01", "PGRST205"])("before the migration (%s) -> null, no throw", async (code) => {
    sessionResults.book_rights_declarations = { data: null, error: { code, message: "missing" } };
    expect(await getCurrentRightsDeclaration(BOOK)).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("any other error -> null (fails closed) and is logged as an error", async () => {
    sessionResults.book_rights_declarations = { data: null, error: { code: "08006", message: "connection" } };
    expect(await getCurrentRightsDeclaration(BOOK)).toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

// F4 (P4): the publish gate's three-way read.
describe("getRightsDeclarationState", () => {
  it("a stored row -> present, with the row, read with the session client", async () => {
    sessionResults.book_rights_declarations = { data: STORED, error: null };
    expect(await getRightsDeclarationState(BOOK)).toEqual({ kind: "present", declaration: STORED });
    expect(sessionCalls.filter((c) => c.table === "book_rights_declarations")[1]).toEqual({
      table: "book_rights_declarations",
      method: "eq",
      args: ["book_id", BOOK],
    });
    expect(adminCreated).toBe(0);
  });

  it("no row -> none", async () => {
    sessionResults.book_rights_declarations = { data: null, error: null };
    expect(await getRightsDeclarationState(BOOK)).toEqual({ kind: "none" });
  });

  it("signed out -> unavailable, without a query", async () => {
    sessionUser = null;
    expect(await getRightsDeclarationState(BOOK)).toEqual({ kind: "unavailable" });
    expect(sessionCalls).toEqual([]);
  });

  it.each(["42P01", "PGRST205"])("before the migration (%s) -> unavailable, never none", async (code) => {
    sessionResults.book_rights_declarations = { data: null, error: { code, message: "missing" } };
    expect(await getRightsDeclarationState(BOOK)).toEqual({ kind: "unavailable" });
    expect(console.error).not.toHaveBeenCalled();
  });

  it("any other read error -> unavailable, logged", async () => {
    sessionResults.book_rights_declarations = { data: null, error: { code: "08006", message: "connection" } };
    expect(await getRightsDeclarationState(BOOK)).toEqual({ kind: "unavailable" });
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
