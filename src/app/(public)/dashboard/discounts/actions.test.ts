import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate added to
// every exported action in this file -- not a general re-test of
// discount-code business logic (which has its own coverage elsewhere).
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

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { createDiscountCode, toggleDiscountCode, deleteDiscountCode } = await import("./actions");

describe("discount code actions: maintenance-mode gate", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("createDiscountCode redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(createDiscountCode(new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/dashboard/discounts?error="));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("toggleDiscountCode throws the stable maintenance error and never reaches Supabase", async () => {
    await expect(toggleDiscountCode("code-1", true)).rejects.toThrow(
      "Librum është përkohësisht i padisponueshëm për mirëmbajtje të planifikuar",
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteDiscountCode throws the stable maintenance error and never reaches Supabase", async () => {
    await expect(deleteDiscountCode("code-1")).rejects.toThrow(
      "Librum është përkohësisht i padisponueshëm për mirëmbajtje të planifikuar",
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves createDiscountCode's existing allowed behavior", async () => {
    vi.unstubAllEnvs();
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "author-1" } } }) },
    });

    // No form fields set -- expected to fail its own existing
    // validation, not the maintenance gate; proves the gate itself is
    // off and the function proceeds into its normal logic.
    await expect(createDiscountCode(new FormData())).rejects.toMatchObject({
      target: "/dashboard/discounts?error=Plot%C3%ABsoni%20t%C3%AB%20gjitha%20fushat",
    });
    expect(mockCreateClient).toHaveBeenCalled();
  });
});

// ALL-DISCOUNT-3: the insert payload, validation and ownership of the
// discount actions, against a recording stub of the Supabase client.
// Every builder call is recorded so a test can assert exactly what
// reached the database layer -- and, as importantly, what never did.
type Recorded = { table: string; op: string; args: unknown[] };

function recordingClient(options: { user?: { id: string } | null; ownsBook?: boolean; insertError?: unknown } = {}) {
  const calls: Recorded[] = [];
  const inserts: Record<string, unknown>[] = [];
  const client = {
    auth: {
      getUser: async () => ({
        data: { user: options.user === undefined ? { id: "author-1" } : options.user },
      }),
    },
    from(table: string) {
      const chain: Record<string, unknown> = {};
      let result: unknown = { data: null, error: null };
      for (const op of ["select", "eq", "update", "delete", "order", "returns"]) {
        chain[op] = (...args: unknown[]) => {
          calls.push({ table, op, args });
          return chain;
        };
      }
      chain.maybeSingle = () => {
        calls.push({ table, op: "maybeSingle", args: [] });
        result = { data: table === "books" && options.ownsBook !== false ? { id: "book-1" } : null, error: null };
        return chain;
      };
      chain.insert = (payload: Record<string, unknown>) => {
        calls.push({ table, op: "insert", args: [payload] });
        inserts.push(payload);
        result = { data: null, error: options.insertError ?? null };
        return chain;
      };
      chain.then = (resolve: (v: unknown) => unknown) => resolve(result);
      return chain;
    },
  };
  return { client, calls, inserts };
}

function discountForm(fields: Record<string, string | File>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

const BASE_FIELDS = { bookId: "book-1", code: "launch20" };
const FIXED_ERROR =
  "/dashboard/discounts?error=Zbritja%20me%20shum%C3%AB%20fikse%20duhet%20t%C3%AB%20jet%C3%AB%20nj%C3%AB%20num%C3%ABr%20i%20plot%C3%AB%20lek%C3%ABsh%20nga%201%20deri%20n%C3%AB%20100.000";

describe("createDiscountCode: ALL fixed discounts and payload shape", () => {
  let stub: ReturnType<typeof recordingClient>;

  beforeEach(() => {
    vi.unstubAllEnvs();
    mockRedirect.mockClear();
    stub = recordingClient();
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(async () => stub.client);
  });

  async function submit(fields: Record<string, string | File>) {
    return createDiscountCode(discountForm(fields)).catch((e: unknown) => e);
  }

  it("percentage creation writes exactly the percentage shape", async () => {
    const outcome = await submit({ ...BASE_FIELDS, type: "percent", value: "20", expiresAt: "2026-12-31" });
    expect(outcome).toMatchObject({ target: "/dashboard/discounts?success=Kodi%20i%20zbritjes%20u%20krijua" });
    expect(stub.inserts).toHaveLength(1);
    const payload = stub.inserts[0];
    expect(Object.keys(payload).sort()).toEqual(
      ["author_id", "book_id", "code", "expires_at", "id", "percent_off"].sort(),
    );
    expect(payload).toMatchObject({
      author_id: "author-1", book_id: "book-1", code: "LAUNCH20", percent_off: 20,
      // DISCOUNT-LIMIT-1: the end of 31 December in Albania (UTC+1).
      expires_at: "2026-12-31T23:00:00.000Z",
    });
    expect(payload.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("percentage bounds and parsing are unchanged", async () => {
    for (const value of ["0", "101", "12.5", "abc", ""]) {
      const outcome = await submit({ ...BASE_FIELDS, type: "percent", value });
      expect(outcome).toMatchObject({ target: "/dashboard/discounts?error=P%C3%ABrqindja%20e%20zbritjes%20duhet%20t%C3%AB%20jet%C3%AB%20nga%201%20deri%20n%C3%AB%20100" });
    }
    expect(stub.inserts).toHaveLength(0);
    await submit({ ...BASE_FIELDS, type: "percent", value: "100" });
    expect(stub.inserts[0]).toMatchObject({ percent_off: 100 });
  });

  it.each([
    ["250", 250],
    ["1", 1],
    ["98", 98],
    ["100000", 100_000],
    ["250,00", 250],
    ["250.00", 250],
    [" 0250 ", 250],
  ])("fixed creation of %j writes integer amount_off_all = %d and nothing else", async (value, expected) => {
    const outcome = await submit({ ...BASE_FIELDS, type: "amount_all", value });
    expect(outcome).toMatchObject({ target: "/dashboard/discounts?success=Kodi%20i%20zbritjes%20u%20krijua" });
    expect(stub.inserts).toHaveLength(1);
    const payload = stub.inserts[0];
    expect(Object.keys(payload).sort()).toEqual(
      ["amount_off_all", "author_id", "book_id", "code", "expires_at", "id"].sort(),
    );
    expect(payload.amount_off_all).toBe(expected);
    expect(Number.isSafeInteger(payload.amount_off_all)).toBe(true);
    expect(payload.expires_at).toBeNull();
  });

  it("never names amount_off_cents in any insert payload, not even as null", async () => {
    await submit({ ...BASE_FIELDS, type: "percent", value: "10" });
    await submit({ ...BASE_FIELDS, code: "fixed", type: "amount_all", value: "500" });
    expect(stub.inserts).toHaveLength(2);
    for (const payload of stub.inserts) {
      expect(Object.prototype.hasOwnProperty.call(payload, "amount_off_cents")).toBe(false);
      expect(JSON.stringify(payload)).not.toContain("amount_off_cents");
    }
    // A percentage code names no fixed column, and a fixed code no percentage.
    expect(stub.inserts[0]).not.toHaveProperty("amount_off_all");
    expect(stub.inserts[1]).not.toHaveProperty("percent_off");
  });

  it.each([
    "0", "0,00", "100001", "250,50", "250.5", "250.000", "1e3", "+250", "-250",
    "1.000", "1,000", "1 000", "", "   ", "abc", "250 lekë", "$5", "9".repeat(400),
  ])("invalid fixed input %j never reaches the insert", async (value) => {
    const outcome = await submit({ ...BASE_FIELDS, type: "amount_all", value });
    expect(outcome).toMatchObject({ target: FIXED_ERROR });
    expect(stub.inserts).toHaveLength(0);
    expect(stub.calls.some((c) => c.table === "discount_codes")).toBe(false);
  });

  it("a non-string fixed value (a File) never reaches the insert", async () => {
    const outcome = await submit({ ...BASE_FIELDS, type: "amount_all", value: new File(["250"], "v.txt") });
    expect(outcome).toMatchObject({ target: FIXED_ERROR });
    expect(stub.inserts).toHaveLength(0);
  });

  it("the retired USD type 'amount' is refused instead of being stored as lek", async () => {
    const outcome = await submit({ ...BASE_FIELDS, type: "amount", value: "5" });
    expect(outcome).toMatchObject({ target: "/dashboard/discounts?error=Zgjidhni%20llojin%20e%20zbritjes" });
    expect(stub.inserts).toHaveLength(0);
  });

  it("an unknown or missing type is refused", async () => {
    for (const type of ["", "amount_cents", "AMOUNT_ALL"]) {
      const outcome = await submit({ ...BASE_FIELDS, type, value: "5" });
      expect(outcome).toMatchObject({ target: "/dashboard/discounts?error=Zgjidhni%20llojin%20e%20zbritjes" });
    }
    expect(stub.inserts).toHaveLength(0);
  });

  it("a database error is still reported, and a duplicate code keeps its message", async () => {
    stub = recordingClient({ insertError: { code: "23505", message: "duplicate" } });
    mockCreateClient.mockImplementation(async () => stub.client);
    const outcome = await submit({ ...BASE_FIELDS, type: "amount_all", value: "250" });
    expect(outcome).toMatchObject({
      target: `/dashboard/discounts?error=${encodeURIComponent("Ky kod ekziston tashmë për këtë libër")}`,
    });
  });

  // SQ-16 (SQ-11 audit N2): any other database error shows the fixed
  // Albanian message, and the database's own text never reaches the URL.
  it("any other database error shows the fixed message, never the database text", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    stub = recordingClient({ insertError: { code: "23514", message: "violates check constraint discount_codes_secret" } });
    mockCreateClient.mockImplementation(async () => stub.client);
    const outcome = await submit({ ...BASE_FIELDS, type: "amount_all", value: "250" });
    expect(outcome).toMatchObject({
      target: `/dashboard/discounts?error=${encodeURIComponent("Kodi nuk u krijua dot. Provoni përsëri.")}`,
    });
    expect(JSON.stringify(outcome)).not.toContain("constraint");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("constraint");
    errorSpy.mockRestore();
  });
});

describe("createDiscountCode / toggle / delete: authorization is preserved", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockRedirect.mockClear();
    mockCreateClient.mockReset();
  });

  it("a signed-out caller is sent to /login and nothing is written", async () => {
    const stub = recordingClient({ user: null });
    mockCreateClient.mockImplementation(async () => stub.client);
    for (const action of [
      () => createDiscountCode(discountForm({ ...BASE_FIELDS, type: "amount_all", value: "250" })),
      () => toggleDiscountCode("code-1", true),
      () => deleteDiscountCode("code-1"),
    ]) {
      await expect(action()).rejects.toMatchObject({ target: "/login" });
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("the book must belong to the signed-in author, checked before any insert", async () => {
    const stub = recordingClient({ ownsBook: false });
    mockCreateClient.mockImplementation(async () => stub.client);
    await expect(
      createDiscountCode(discountForm({ ...BASE_FIELDS, type: "amount_all", value: "250" })),
    ).rejects.toMatchObject({ target: "/dashboard/discounts?error=Zgjidhni%20nj%C3%AB%20nga%20librat%20tuaj" });
    expect(stub.inserts).toHaveLength(0);
    const eqs = stub.calls.filter((c) => c.table === "books" && c.op === "eq").map((c) => c.args);
    expect(eqs).toEqual([["id", "book-1"], ["author_id", "author-1"]]);
  });

  it("author_id is always the signed-in user, never a form field", async () => {
    const stub = recordingClient();
    mockCreateClient.mockImplementation(async () => stub.client);
    await createDiscountCode(
      discountForm({ ...BASE_FIELDS, type: "amount_all", value: "250", author_id: "someone-else", authorId: "x" }),
    ).catch(() => undefined);
    expect(stub.inserts[0].author_id).toBe("author-1");
  });

  it("toggle updates only `active`, scoped to the code id and the signed-in author", async () => {
    const stub = recordingClient();
    mockCreateClient.mockImplementation(async () => stub.client);
    await toggleDiscountCode("code-1", true);
    const ops = stub.calls.filter((c) => c.table === "discount_codes");
    expect(ops).toEqual([
      { table: "discount_codes", op: "update", args: [{ active: false }] },
      { table: "discount_codes", op: "eq", args: ["id", "code-1"] },
      { table: "discount_codes", op: "eq", args: ["author_id", "author-1"] },
    ]);
  });

  it("delete is scoped to the code id and the signed-in author", async () => {
    const stub = recordingClient();
    mockCreateClient.mockImplementation(async () => stub.client);
    await deleteDiscountCode("code-1");
    const ops = stub.calls.filter((c) => c.table === "discount_codes");
    expect(ops).toEqual([
      { table: "discount_codes", op: "delete", args: [] },
      { table: "discount_codes", op: "eq", args: ["id", "code-1"] },
      { table: "discount_codes", op: "eq", args: ["author_id", "author-1"] },
    ]);
  });
});

// DISCOUNT-LIMIT-1: the optional use limit and the end-of-day expiry.
describe("createDiscountCode: max uses and expiry", () => {
  let stub: ReturnType<typeof recordingClient>;

  beforeEach(() => {
    vi.unstubAllEnvs();
    mockRedirect.mockClear();
    stub = recordingClient();
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(async () => stub.client);
  });

  async function submit(fields: Record<string, string | File>) {
    return createDiscountCode(discountForm({ ...BASE_FIELDS, type: "percent", value: "10", ...fields })).catch(
      (e: unknown) => e,
    );
  }

  it.each([["1", 1], [" 25 ", 25], ["100000", 100_000]])("max uses %j is stored as %d", async (maxUses, expected) => {
    const outcome = await submit({ maxUses });
    expect(outcome).toMatchObject({ target: "/dashboard/discounts?success=Kodi%20i%20zbritjes%20u%20krijua" });
    expect(stub.inserts).toHaveLength(1);
    expect(stub.inserts[0].max_uses).toBe(expected);
  });

  it("blank or missing max uses leaves max_uses out of the payload (no limit)", async () => {
    await submit({ maxUses: "" });
    await submit({ code: "other" });
    expect(stub.inserts).toHaveLength(2);
    for (const payload of stub.inserts) {
      expect(Object.prototype.hasOwnProperty.call(payload, "max_uses")).toBe(false);
    }
  });

  it.each(["0", "100001", "-3", "2.5", "1e2", "ten"])("max uses %j never reaches the insert", async (maxUses) => {
    const outcome = await submit({ maxUses });
    expect(outcome).toMatchObject({
      target: "/dashboard/discounts?error=Numri%20maksimal%20i%20p%C3%ABrdorimeve%20duhet%20t%C3%AB%20jet%C3%AB%20nj%C3%AB%20num%C3%ABr%20i%20plot%C3%AB%20nga%201%20deri%20n%C3%AB%20100.000",
    });
    expect(stub.inserts).toHaveLength(0);
  });

  it("a picked date is stored as the next midnight in Albania, summer time included", async () => {
    await submit({ expiresAt: "2026-07-10" });
    expect(stub.inserts[0].expires_at).toBe("2026-07-10T22:00:00.000Z");
  });

  it("no date means no expiry", async () => {
    await submit({ expiresAt: "" });
    expect(stub.inserts[0].expires_at).toBeNull();
  });

  it("a malformed date never reaches the insert", async () => {
    const outcome = await submit({ expiresAt: "2026-02-30" });
    expect(outcome).toMatchObject({ target: "/dashboard/discounts?error=Zgjidhni%20nj%C3%AB%20dat%C3%AB%20skadimi%20t%C3%AB%20vlefshme" });
    expect(stub.inserts).toHaveLength(0);
  });
});
