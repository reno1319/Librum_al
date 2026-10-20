import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestClient } from "@supabase/postgrest-js";
import { resetSchemaFeatureOffLogForTests } from "./schema-feature-off";

// PEN-NAMES-2 (D4): only the rights probe is left -- books.pen_name is
// dropped by the contract, and the Pen name field writes pen_name_id.
// F4 (D1, check N2): the probe through the REAL @supabase/postgrest-js
// (2.112.3, the version supabase-js ships here) with only `fetch` mocked,
// so what each server answer turns into -- including postgrest-js's own
// "404 with an empty body becomes 204, no error" -- is the library's,
// not a hand-written double's.

type Answer = { status: number; body: string; contentType?: string };
let answers: Record<string, Answer>;
let requests: { url: string; method: string }[];

const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, method: init?.method ?? "GET" });
  const table = new URL(url).pathname.split("/").pop()!;
  const answer = answers[table];
  if (!answer) throw new Error(`no answer for ${table}`);
  return new Response(answer.body === "" ? null : answer.body, {
    status: answer.status,
    headers: { "content-type": answer.contentType ?? "application/json" },
  });
});

const postgrest = new PostgrestClient("http://127.0.0.1:54321/rest/v1", { fetch: fetchMock as typeof fetch });
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => postgrest.from(table) }),
}));

const { getCatalogSchemaFeatures, resetCatalogSchemaFeaturesForTests } = await import("./catalog-schema-features");

const PRESENT: Answer = { status: 200, body: "[]" };
const NOT_FOUND_EMPTY: Answer = { status: 404, body: "" };
const UNDEFINED_COLUMN: Answer = {
  status: 400,
  body: JSON.stringify({ code: "42703", details: null, hint: null, message: "column book_rights_declarations.id does not exist" }),
};
const TABLE_NOT_IN_CACHE: Answer = {
  status: 404,
  body: JSON.stringify({
    code: "PGRST205",
    details: null,
    hint: null,
    message: "Could not find the table 'public.book_rights_declarations' in the schema cache",
  }),
};

beforeEach(() => {
  resetCatalogSchemaFeaturesForTests();
  resetSchemaFeatureOffLogForTests();
  requests = [];
  fetchMock.mockClear();
  answers = { book_rights_declarations: PRESENT };
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("getCatalogSchemaFeatures: what each answer means (real postgrest-js)", () => {
  it.each([
    ["404 with an empty body", NOT_FOUND_EMPTY, false],
    ["400 with 42703 (undefined column)", UNDEFINED_COLUMN, false],
    ["404 with PGRST205 (table not in the schema cache)", TABLE_NOT_IN_CACHE, false],
    ["200 with []", PRESENT, true],
  ])("%s -> %s", async (_label, answer, expected) => {
    answers = { book_rights_declarations: answer };
    expect(await getCatalogSchemaFeatures()).toEqual({ rights: expected });
  });

  it("a 500 or any other error is off", async () => {
    answers = { book_rights_declarations: { status: 500, body: JSON.stringify({ message: "boom" }) } };
    expect(await getCatalogSchemaFeatures()).toEqual({ rights: false });
  });

  // postgrest-js retries a GET whose fetch throws (1 s, 2 s, 4 s), so this
  // one waits for its retries to run out.
  it("a thrown request is off, never an error page", { timeout: 20_000 }, async () => {
    answers = {} as Record<string, Answer>;
    expect(await getCatalogSchemaFeatures()).toEqual({ rights: false });
  });

  it("PEN-NAMES-2: there is no pen name feature any more (books.pen_name is never probed)", async () => {
    const result = await getCatalogSchemaFeatures();
    expect(Object.keys(result)).toEqual(["rights"]);
    expect(requests.some((r) => r.url.includes("/books?"))).toBe(false);
  });
});

describe("getCatalogSchemaFeatures: how it asks", () => {
  it("never uses HEAD: the probe is a normal GET with limit 0, on the right column", async () => {
    await getCatalogSchemaFeatures();
    expect(requests).toHaveLength(1);
    for (const request of requests) expect(request.method).toBe("GET");
    const rights = new URL(requests[0].url);
    expect(rights.pathname.endsWith("/book_rights_declarations")).toBe(true);
    expect(rights.searchParams.get("select")).toBe("id");
    expect(rights.searchParams.get("limit")).toBe("0");
  });

  it("the source never passes head: true", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./catalog-schema-features.ts", import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toMatch(/head:\s*true/);
    expect(code).not.toMatch(/\bhead\b/);
  });
});

describe("getCatalogSchemaFeatures: caching", () => {
  it("a present answer is cached for the process: no further requests", async () => {
    await getCatalogSchemaFeatures();
    expect(requests).toHaveLength(1);
    answers = { book_rights_declarations: NOT_FOUND_EMPTY };
    expect(await getCatalogSchemaFeatures()).toEqual({ rights: true });
    expect(requests).toHaveLength(1);
  });

  it("an off answer is never cached: the next request sees the migration", async () => {
    answers = { book_rights_declarations: TABLE_NOT_IN_CACHE };
    expect(await getCatalogSchemaFeatures()).toEqual({ rights: false });
    answers = { book_rights_declarations: PRESENT };
    expect(await getCatalogSchemaFeatures()).toEqual({ rights: true });
    expect(requests).toHaveLength(2);
  });
});
