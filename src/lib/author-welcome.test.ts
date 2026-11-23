import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const afterTasks: Array<() => Promise<unknown>> = [];
let afterThrows = false;
vi.mock("next/server", () => ({
  after: (task: () => Promise<unknown>) => {
    if (afterThrows) throw new Error("outside a request");
    afterTasks.push(task);
  },
}));

const mockSendWelcome = vi.fn(async (_to: string, _args: { name: string | null }) => undefined);
const mockSendHouseWelcome = vi.fn(async (_to: string, _args: { name: string | null }) => undefined);
vi.mock("@/lib/email", () => ({
  sendAuthorWelcomeEmail: (to: string, args: { name: string | null }) => mockSendWelcome(to, args),
  sendHouseWelcomeEmail: (to: string, args: { name: string | null }) => mockSendHouseWelcome(to, args),
}));

let recipient: { email: string; name: string | null } | null = { email: "ana@example.com", name: "Ana" };
const mockRecipient = vi.fn(async () => recipient);
vi.mock("@/lib/author-recipient", () => ({ authorRecipient: () => mockRecipient() }));

// A tiny profiles table: the claim is a conditional UPDATE ... RETURNING.
type Row = {
  id: string;
  role: string;
  account_kind: string;
  public_author_name?: string | null;
  author_welcome_sent_at: string | null;
};
let rows: Row[] = [];
let claimError: { code: string } | null = null;
const claims: Array<{ values: Record<string, unknown>; filters: string[] }> = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      expect(table).toBe("profiles");
      const tests: Array<(r: Row) => boolean> = [];
      const record = { values: {} as Record<string, unknown>, filters: [] as string[] };
      const chain = {
        update: (values: Record<string, unknown>) => {
          record.values = values;
          return chain;
        },
        eq: (c: keyof Row, v: unknown) => {
          record.filters.push(`${c}=${String(v)}`);
          tests.push((r) => r[c] === v);
          return chain;
        },
        is: (c: keyof Row, v: null) => {
          record.filters.push(`${c} is ${String(v)}`);
          tests.push((r) => r[c] === v);
          return chain;
        },
        select: async (columns: string) => {
          record.filters.push(`select ${columns}`);
          claims.push(record);
          if (claimError) return { data: null, error: claimError };
          const hit = rows.filter((r) => tests.every((t) => t(r)));
          for (const r of hit) Object.assign(r, record.values);
          return {
            data: hit.map((r) => ({ id: r.id, account_kind: r.account_kind, public_author_name: r.public_author_name ?? null })),
            error: null,
          };
        },
      };
      return chain;
    },
  }),
}));

const { sendAuthorWelcomeOnce, scheduleAuthorWelcome } = await import("./author-welcome");

beforeEach(() => {
  rows = [
    { id: "author-new", role: "author", account_kind: "person", author_welcome_sent_at: null },
    { id: "author-old", role: "author", account_kind: "person", author_welcome_sent_at: "2026-11-17T18:00:00Z" },
    { id: "reader", role: "reader", account_kind: "person", author_welcome_sent_at: null },
    { id: "house", role: "author", account_kind: "publishing_house", public_author_name: " Botime\n Test ", author_welcome_sent_at: null },
    { id: "house-noname", role: "author", account_kind: "publishing_house", public_author_name: "  ", author_welcome_sent_at: null },
    { id: "house-old", role: "author", account_kind: "publishing_house", public_author_name: "B", author_welcome_sent_at: "2026-11-23T14:00:00Z" },
  ];
  claimError = null;
  claims.length = 0;
  afterTasks.length = 0;
  afterThrows = false;
  recipient = { email: "ana@example.com", name: "Ana" };
  mockSendWelcome.mockClear();
  mockSendHouseWelcome.mockClear();
  mockRecipient.mockClear();
});

describe("sendAuthorWelcomeOnce", () => {
  it("claims an author row still unwelcomed, then sends once with the greeting name", async () => {
    await sendAuthorWelcomeOnce("author-new");
    expect(claims[0].filters).toEqual([
      "id=author-new",
      "role=author",
      "author_welcome_sent_at is null",
      "select id, account_kind, public_author_name",
    ]);
    expect(typeof claims[0].values.author_welcome_sent_at).toBe("string");
    expect(mockSendWelcome).toHaveBeenCalledExactlyOnceWith("ana@example.com", { name: "Ana" });
    expect(mockSendHouseWelcome).not.toHaveBeenCalled();
  });

  it("never twice: a second call (refresh, second tab) finds nothing to claim", async () => {
    await Promise.all([sendAuthorWelcomeOnce("author-new"), sendAuthorWelcomeOnce("author-new")]);
    await sendAuthorWelcomeOnce("author-new");
    expect(mockSendWelcome).toHaveBeenCalledTimes(1);
  });

  it("an author already welcomed (or marked by the migration) gets nothing", async () => {
    await sendAuthorWelcomeOnce("author-old");
    expect(mockRecipient).not.toHaveBeenCalled();
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it("a reader gets nothing and stays unclaimed (so becoming an author later still counts)", async () => {
    await sendAuthorWelcomeOnce("reader");
    expect(mockSendWelcome).not.toHaveBeenCalled();
    expect(rows.find((r) => r.id === "reader")?.author_welcome_sent_at).toBeNull();
  });

  // BUILD 2a-2 (h4 ok): a house is claimed the same way and gets the
  // house welcome (never the author one), greeted by the house name.
  it("a publishing house gets the house welcome once, greeted by its house name", async () => {
    await sendAuthorWelcomeOnce("house");
    await sendAuthorWelcomeOnce("house");
    expect(mockSendWelcome).not.toHaveBeenCalled();
    expect(mockSendHouseWelcome).toHaveBeenCalledExactlyOnceWith("ana@example.com", { name: "Botime Test" });
    expect(typeof rows.find((r) => r.id === "house")?.author_welcome_sent_at).toBe("string");
  });

  it("a house with no public name is greeted by the account greeting name", async () => {
    await sendAuthorWelcomeOnce("house-noname");
    expect(mockSendHouseWelcome).toHaveBeenCalledExactlyOnceWith("ana@example.com", { name: "Ana" });
  });

  it("a house already welcomed gets nothing", async () => {
    await sendAuthorWelcomeOnce("house-old");
    expect(mockSendHouseWelcome).not.toHaveBeenCalled();
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it("a failed claim sends nothing", async () => {
    claimError = { code: "XX000" };
    await sendAuthorWelcomeOnce("author-new");
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it("no address: claimed, nothing sent, nothing thrown", async () => {
    recipient = null;
    await sendAuthorWelcomeOnce("author-new");
    expect(mockSendWelcome).not.toHaveBeenCalled();
  });

  it("never throws, even when the send does", async () => {
    mockSendWelcome.mockRejectedValueOnce(new Error("down"));
    await expect(sendAuthorWelcomeOnce("author-new")).resolves.toBeUndefined();
  });
});

describe("scheduleAuthorWelcome", () => {
  it("runs the send after the response", async () => {
    scheduleAuthorWelcome("author-new");
    expect(mockSendWelcome).not.toHaveBeenCalled();
    expect(afterTasks).toHaveLength(1);
    await afterTasks[0]();
    expect(mockSendWelcome).toHaveBeenCalledTimes(1);
  });

  it("never throws when it can't be scheduled", () => {
    afterThrows = true;
    expect(() => scheduleAuthorWelcome("author-new")).not.toThrow();
  });
});
