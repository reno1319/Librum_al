import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// BECOME-AUTHOR-1: pins every rule listed in
// src/lib/author-role-write-client.ts against the REAL becomeAuthor
// Server Action. The session client and the privileged writer are
// separate fakes, so each test can see which of them did what.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

let recoveryActive: boolean;
vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === RECOVERY_COOKIE_NAME && recoveryActive ? { value: "1" } : undefined,
    }),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

let authUser: { id: string } | null;
let profileResult: { data: unknown; error: unknown };
let profileFilters: Array<[string, unknown]>;
let sessionCalls: string[];
let writerCreated: number;
let updateResult: { data: unknown; error: unknown };
let writes: Array<{ table: string; values: unknown; filters: Array<[string, unknown]>; columns: string }>;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => {
        sessionCalls.push("getUser");
        return { data: { user: authUser } };
      },
    },
    from: (table: string) => {
      sessionCalls.push(`from:${table}`);
      if (table !== "profiles") throw new Error(`unexpected session table ${table}`);
      return {
        select: (columns: string) => {
          sessionCalls.push(`select:${columns}`);
          const chain = {
            eq: (column: string, value: unknown) => {
              profileFilters.push([column, value]);
              return chain;
            },
            maybeSingle: async () => profileResult,
          };
          return chain;
        },
        update: () => {
          throw new Error("the session client must never write the role");
        },
      };
    },
  }),
}));

vi.mock("@/lib/author-role-write-client", () => ({
  createAuthorRoleWriteClient: () => {
    writerCreated += 1;
    return {
      from: (table: string) => ({
        update: (values: unknown) => {
          const write = { table, values, filters: [] as Array<[string, unknown]>, columns: "" };
          writes.push(write);
          const chain = {
            eq: (column: string, value: unknown) => {
              write.filters.push([column, value]);
              return chain;
            },
            select: async (columns: string) => {
              write.columns = columns;
              return updateResult;
            },
          };
          return chain;
        },
      }),
    };
  },
}));

const { becomeAuthor } = await import("./become-author");

async function run(): Promise<string> {
  try {
    await becomeAuthor();
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  throw new Error("becomeAuthor returned without redirecting");
}

function readerProfile(overrides: Record<string, unknown> = {}) {
  return { data: { id: USER_ID, role: "reader", display_name: "Ana Reader", ...overrides }, error: null };
}

beforeEach(() => {
  recoveryActive = false;
  authUser = { id: USER_ID };
  profileResult = readerProfile();
  profileFilters = [];
  sessionCalls = [];
  writerCreated = 0;
  updateResult = { data: [{ id: USER_ID, role: "author" }], error: null };
  writes = [];
  revalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("becomeAuthor", () => {
  it("turns the caller's own reader row into an author row, exactly as author signup would", async () => {
    const target = await run();

    expect(target.startsWith("/dashboard?success=")).toBe(true);
    expect(profileFilters).toEqual([["id", USER_ID]]);
    expect(writerCreated).toBe(1);
    expect(writes).toEqual([
      {
        table: "profiles",
        values: { role: "author", public_author_name: "Ana Reader" },
        filters: [
          ["id", USER_ID],
          ["role", "reader"],
        ],
        columns: "id, role",
      },
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("does nothing during a password-recovery session, before any Supabase call", async () => {
    recoveryActive = true;
    expect(await run()).toBe("/reset-password");
    expect(sessionCalls).toEqual([]);
    expect(writerCreated).toBe(0);
  });

  it("sends a signed-out visitor to login without creating the privileged writer", async () => {
    authUser = null;
    expect(await run()).toBe("/login?next=/account");
    expect(writerCreated).toBe(0);
  });

  it("sends an existing author to the dashboard without writing", async () => {
    profileResult = readerProfile({ role: "author" });
    expect(await run()).toBe("/dashboard");
    expect(writerCreated).toBe(0);
  });

  it.each(["admin", "staff", "", null, "AUTHOR"])("never rewrites a %s profile", async (role) => {
    profileResult = readerProfile({ role });
    const target = await run();
    expect(target.startsWith("/account?error=")).toBe(true);
    expect(writerCreated).toBe(0);
  });

  it("fails closed without writing when the profile read errors, is missing or is someone else's", async () => {
    for (const result of [
      { data: null, error: { message: "db down" } },
      { data: null, error: null },
      { data: { id: OTHER_ID, role: "reader", display_name: "Other" }, error: null },
    ]) {
      profileResult = result;
      const target = await run();
      expect(target.startsWith("/account?error=")).toBe(true);
    }
    expect(writerCreated).toBe(0);
  });

  it("fails closed without writing when the stored display name is not a string", async () => {
    profileResult = readerProfile({ display_name: null });
    const target = await run();
    expect(target.startsWith("/account?error=")).toBe(true);
    expect(writerCreated).toBe(0);
  });

  it("ignores anything the form submits", async () => {
    const formData = new FormData();
    formData.set("role", "admin");
    formData.set("public_author_name", "Injected");
    formData.set("id", OTHER_ID);
    try {
      await (becomeAuthor as unknown as (fd: FormData) => Promise<void>)(formData);
    } catch (e) {
      if (!(e instanceof RedirectSignal)) throw e;
    }
    expect(writes[0]?.values).toEqual({ role: "author", public_author_name: "Ana Reader" });
    expect(writes[0]?.filters).toEqual([
      ["id", USER_ID],
      ["role", "reader"],
    ]);
  });

  it.each([
    ["an update error", { data: null, error: { code: "23514", message: "check violation" } }],
    ["zero rows", { data: [], error: null }],
    ["two rows", { data: [{ id: USER_ID, role: "author" }, { id: OTHER_ID, role: "author" }], error: null }],
    ["another user's row", { data: [{ id: OTHER_ID, role: "author" }], error: null }],
    ["a row that is not an author", { data: [{ id: USER_ID, role: "reader" }], error: null }],
    ["no array", { data: null, error: null }],
  ])("reports failure on %s and does not claim success", async (_label, result) => {
    updateResult = result;
    const target = await run();
    expect(target.startsWith("/account?error=")).toBe(true);
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe("author role write boundary (static)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");

  it("the writer module is server-only", () => {
    expect(read("src/lib/author-role-write-client.ts")).toMatch(/^import "server-only";/);
  });

  it("becomeAuthor is the writer's only importer", () => {
    const out = execFileSync("grep", ["-rl", "author-role-write-client", "src"], { cwd: root, encoding: "utf8" });
    const importers = out
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith(".test.ts") && f !== "src/lib/author-role-write-client.ts");
    expect(importers).toEqual(["src/app/(public)/account/become-author.ts"]);
  });
});
