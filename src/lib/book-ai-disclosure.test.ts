import { beforeEach, describe, expect, it, vi } from "vitest";

// BD15 P3: the staff-only AI answer goes only through the trusted writer.
vi.mock("server-only", () => ({}));
const calls: { table: string; op: string; args: unknown[] }[] = [];
let readResult: { data: unknown; error: unknown } = { data: null, error: null };
let writeError: unknown = null;
vi.mock("@/lib/catalog-write-client", () => ({
  createCatalogWriteClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: (...args: unknown[]) => (calls.push({ table, op: "select", args }), chain),
        eq: (...args: unknown[]) => (calls.push({ table, op: "eq", args }), chain),
        maybeSingle: async () => readResult,
        upsert: async (...args: unknown[]) => (calls.push({ table, op: "upsert", args }), { error: writeError }),
      };
      return chain;
    },
  }),
}));

const { parseAiAnswer, readAiDisclosure, writeAiDisclosure } = await import("./book-ai-disclosure");
const BOOK = "c3333333-3333-4333-8333-333333333333";

beforeEach(() => {
  calls.length = 0;
  readResult = { data: null, error: null };
  writeError = null;
});

describe("book-ai-disclosure", () => {
  it("parses only yes or no", () => {
    expect(parseAiAnswer("yes")).toBe("yes");
    expect(parseAiAnswer("no")).toBe("no");
    for (const v of [null, "", "Yes", "true", "1"]) expect(parseAiAnswer(v)).toBeNull();
  });

  it("reads the book's one row: none = not answered, an error = unreadable", async () => {
    expect(await readAiDisclosure(BOOK)).toEqual({ ok: true, answer: null });
    expect(calls).toContainEqual({ table: "book_ai_disclosures", op: "eq", args: ["book_id", BOOK] });
    readResult = { data: { ai_used: true }, error: null };
    expect(await readAiDisclosure(BOOK)).toEqual({ ok: true, answer: "yes" });
    readResult = { data: { ai_used: false }, error: null };
    expect(await readAiDisclosure(BOOK)).toEqual({ ok: true, answer: "no" });
    readResult = { data: null, error: { code: "42501" } };
    expect(await readAiDisclosure(BOOK)).toEqual({ ok: false });
  });

  it("writes one row per book (upsert on book_id) and reports a failure", async () => {
    expect(await writeAiDisclosure(BOOK, "yes")).toBe("ok");
    const upsert = calls.find((c) => c.op === "upsert")!;
    expect(upsert.table).toBe("book_ai_disclosures");
    expect(upsert.args[0]).toEqual(expect.objectContaining({ book_id: BOOK, ai_used: true }));
    expect(upsert.args[1]).toEqual({ onConflict: "book_id" });
    writeError = { code: "42501" };
    expect(await writeAiDisclosure(BOOK, "no")).toBe("failed");
  });

  it("BD15 P5a: a book waiting for review refuses the answer (LB490)", async () => {
    writeError = { code: "LB490" };
    expect(await writeAiDisclosure(BOOK, "yes")).toBe("in_review");
  });
});
