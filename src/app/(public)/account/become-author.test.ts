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
const PEN_ID = "33333333-3333-4333-8333-333333333333";
const LEGACY_PNG = `${USER_ID}/avatar.png`;
const NEW_PEN_PHOTO = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/pen-name\.(jpg|png)$/;

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
          order.push("role");
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

// PEN-2 (17a after C8): the pen-name writer copies a legacy account photo
// to a fresh pen-name key and compares-and-sets it on the default pen
// name. It is a separate fake so each test sees exactly what it did.
type PenOp =
  | { op: "read"; filters: Array<[string, unknown]> }
  | { op: "copy"; bucket: string; from: string; to: string }
  | { op: "update"; values: unknown; filters: Array<[string, unknown]>; nullCheck: string | null }
  | { op: "remove"; bucket: string; paths: string[] };
let penWriterCreated: number;
let penOps: PenOp[];
let defaultPenName: { data: unknown; error: unknown };
let copyResult: { error: unknown };
let penUpdateResult: { data: unknown; error: unknown };

vi.mock("@/lib/pen-name-write-client", () => ({
  createPenNameWriteClient: () => {
    penWriterCreated += 1;
    return {
      from: (table: string) => {
        if (table !== "pen_names") throw new Error(`unexpected pen writer table ${table}`);
        return {
          select: () => {
            const read = { op: "read" as const, filters: [] as Array<[string, unknown]> };
            penOps.push(read);
            const chain = {
              eq: (column: string, value: unknown) => (read.filters.push([column, value]), chain),
              maybeSingle: async () => defaultPenName,
            };
            return chain;
          },
          update: (values: unknown) => {
            const write = { op: "update" as const, values, filters: [] as Array<[string, unknown]>, nullCheck: null as string | null };
            penOps.push(write);
            const chain = {
              eq: (column: string, value: unknown) => (write.filters.push([column, value]), chain),
              is: (column: string, value: unknown) => {
                if (value !== null) throw new Error("only .is(col, null) is expected");
                write.nullCheck = column;
                return chain;
              },
              select: async () => penUpdateResult,
            };
            return chain;
          },
        };
      },
      storage: {
        from: (bucket: string) => ({
          copy: async (from: string, to: string) => {
            penOps.push({ op: "copy", bucket, from, to });
            return copyResult;
          },
          remove: async (paths: string[]) => {
            penOps.push({ op: "remove", bucket, paths });
            return { error: null };
          },
        }),
      },
    };
  },
}));

// AUTHOR-AGE-1 + SECURITY-9A: the "I'm 18 or older" and Terms records go
// through the service role's auth admin API in one write
// (src/lib/agreement-records.ts); this fake records each call and the
// order against the role write.
let ageCalls: Array<{ id: string; attributes: { app_metadata?: Record<string, unknown> } }>;
let ageResult: { error: unknown };
let order: string[];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: {
      admin: {
        updateUserById: async (id: string, attributes: { app_metadata?: Record<string, unknown> }) => {
          ageCalls.push({ id, attributes });
          order.push("age");
          return { data: null, error: ageResult.error };
        },
      },
    },
  }),
}));

const { becomeAuthor } = await import("./become-author");

function tickedForm(): FormData {
  const formData = new FormData();
  formData.set("confirm_author_age", "on");
  formData.set("accept_terms", "on");
  return formData;
}

async function run(formData: FormData = tickedForm()): Promise<string> {
  try {
    await becomeAuthor(formData);
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
  vi.spyOn(console, "warn").mockImplementation(() => {});
  penWriterCreated = 0;
  penOps = [];
  defaultPenName = { data: { id: PEN_ID, avatar_path: null }, error: null };
  copyResult = { error: null };
  penUpdateResult = { data: [{ id: PEN_ID }], error: null };
  ageCalls = [];
  ageResult = { error: null };
  order = [];
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
    const formData = tickedForm();
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

describe("becomeAuthor: N3 name trim", () => {
  it("trims the stored display name before it becomes the public author name", async () => {
    profileResult = readerProfile({ display_name: "  Ana Reader \t" });
    const target = await run();
    expect(target.startsWith("/dashboard?success=")).toBe(true);
    expect(writes[0]?.values).toEqual({ role: "author", public_author_name: "Ana Reader" });
  });

  it.each(["", "   ", "\t\n"])("refuses a name that is empty after trimming (%j), with the profile page's message", async (name) => {
    profileResult = readerProfile({ display_name: name });
    const target = await run();
    expect(target).toBe(`/account?error=${encodeURIComponent("Public author name can't be empty")}`);
    expect(writerCreated).toBe(0);
    expect(penWriterCreated).toBe(0);
  });
});

describe("becomeAuthor: legacy photo copied to the default pen name (17a after C8)", () => {
  function logged(): string {
    const spies = [console.error, console.warn] as unknown as Array<{ mock: { calls: unknown[][] } }>;
    return JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
  }

  it("copies the account photo to a fresh pen-name key and sets it with a CAS on an empty photo", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    const target = await run();

    expect(target.startsWith("/dashboard?success=")).toBe(true);
    expect(penWriterCreated).toBe(1);
    const [read, copy, update, ...rest] = penOps;
    expect(read).toEqual({ op: "read", filters: [["author_id", USER_ID], ["is_default", true]] });
    expect(copy).toMatchObject({ op: "copy", bucket: "avatars", from: LEGACY_PNG });
    const to = (copy as { to: string }).to;
    expect(to).toMatch(NEW_PEN_PHOTO);
    expect(to.endsWith(".png")).toBe(true);
    expect(to).not.toContain(USER_ID);
    expect(update).toEqual({
      op: "update",
      values: { avatar_path: to },
      filters: [["id", PEN_ID], ["author_id", USER_ID]],
      nullCheck: "avatar_path",
    });
    expect(rest).toEqual([]);
  });

  it("a .jpg photo keeps its extension", async () => {
    profileResult = readerProfile({ avatar_path: `${USER_ID}/avatar.jpg` });
    await run();
    const copy = penOps.find((op) => op.op === "copy") as { to: string };
    expect(copy.to.endsWith("/pen-name.jpg")).toBe(true);
  });

  it("when the database already copied the legacy key to the pen name, the CAS is on that key", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    defaultPenName = { data: { id: PEN_ID, avatar_path: LEGACY_PNG }, error: null };
    await run();
    const update = penOps.find((op) => op.op === "update") as { filters: Array<[string, unknown]>; nullCheck: string | null };
    expect(update.nullCheck).toBeNull();
    expect(update.filters).toEqual([["id", PEN_ID], ["author_id", USER_ID], ["avatar_path", LEGACY_PNG]]);
  });

  it("a CAS miss (the author changed the photo meanwhile) removes its own copy and nothing else", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    penUpdateResult = { data: [], error: null };
    const target = await run();
    expect(target.startsWith("/dashboard?success=")).toBe(true);
    const copy = penOps.find((op) => op.op === "copy") as { to: string };
    expect(penOps.at(-1)).toEqual({ op: "remove", bucket: "avatars", paths: [copy.to] });
    expect(penOps.filter((op) => op.op === "remove")).toHaveLength(1);
  });

  it("an update error also removes the copy; the switch still succeeds", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    penUpdateResult = { data: null, error: { code: "23505" } };
    expect((await run()).startsWith("/dashboard?success=")).toBe(true);
    expect(penOps.at(-1)?.op).toBe("remove");
  });

  it("a missing legacy object (copy fails) writes nothing and the switch still succeeds", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    copyResult = { error: { statusCode: "404", message: "Object not found" } };
    expect((await run()).startsWith("/dashboard?success=")).toBe(true);
    expect(penOps.map((op) => op.op)).toEqual(["read", "copy"]);
  });

  it("a pen name that already has its own photo is left alone: no copy", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    defaultPenName = { data: { id: PEN_ID, avatar_path: "44444444-4444-4444-8444-444444444444/pen-name.png" }, error: null };
    await run();
    expect(penOps.map((op) => op.op)).toEqual(["read"]);
  });

  it("no default pen name found: nothing copied", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    defaultPenName = { data: null, error: null };
    expect((await run()).startsWith("/dashboard?success=")).toBe(true);
    expect(penOps.map((op) => op.op)).toEqual(["read"]);
  });

  it.each([
    ["no photo", null],
    ["someone else's canonical photo", `${OTHER_ID}/avatar.png`],
    ["a non-canonical key", `${USER_ID}/selfie.png`],
    ["a traversal", `${USER_ID}/../${OTHER_ID}/avatar.png`],
    ["a .jpeg key", `${USER_ID}/avatar.jpeg`],
  ])("%s: the pen-name writer is never created", async (_label, avatarPath) => {
    profileResult = readerProfile({ avatar_path: avatarPath });
    expect((await run()).startsWith("/dashboard?success=")).toBe(true);
    expect(penWriterCreated).toBe(0);
  });

  it("the photo is only copied after the role write succeeded", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    updateResult = { data: [], error: null };
    expect((await run()).startsWith("/account?error=")).toBe(true);
    expect(penWriterCreated).toBe(0);
  });

  it("no log line carries a storage key or the account id", async () => {
    profileResult = readerProfile({ avatar_path: LEGACY_PNG });
    penUpdateResult = { data: [], error: null };
    await run();
    copyResult = { error: { message: "not found" } };
    await run();
    defaultPenName = { data: null, error: { message: "db" } };
    await run();
    const text = logged();
    expect(text.length).toBeGreaterThan(2);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain("avatar.png");
    expect(text).not.toContain("pen-name.");
  });
});

describe("becomeAuthor: AUTHOR-AGE-1 18+ tick", () => {
  const AGE_ERROR = `/account?error=${encodeURIComponent("Authors must be 18 or older. Tick the box to confirm.")}`;

  it("records the confirmation for the caller's own id, before the role write", async () => {
    expect((await run()).startsWith("/dashboard?success=")).toBe(true);
    expect(ageCalls).toHaveLength(1);
    expect(ageCalls[0].id).toBe(USER_ID);
    expect(Object.keys(ageCalls[0].attributes)).toEqual(["app_metadata"]);
    const meta = ageCalls[0].attributes.app_metadata ?? {};
    expect(meta.author_age_statement_version).toBe("author-age-v1");
    expect(Number.isNaN(Date.parse(String(meta.author_age_confirmed_at)))).toBe(false);
    // SECURITY-9A: the same write records the Terms.
    expect(meta.terms_version).toBe("terms-2026-10");
    expect(meta.terms_accepted_at).toBe(meta.author_age_confirmed_at);
    expect(order).toEqual(["age", "role"]);
  });

  it.each([
    ["no tick", new FormData()],
    ["a tick with another value", (() => { const f = new FormData(); f.set("confirm_author_age", "yes"); return f; })()],
  ])("%s: refused with the age message, nothing recorded or written", async (_label, formData) => {
    expect(await run(formData)).toBe(AGE_ERROR);
    expect(ageCalls).toHaveLength(0);
    expect(writerCreated).toBe(0);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("an existing author still goes to the dashboard, tick or not, and nothing is recorded", async () => {
    profileResult = readerProfile({ role: "author" });
    expect(await run(new FormData())).toBe("/dashboard");
    expect(ageCalls).toHaveLength(0);
  });

  it("a failed record fails closed: the role is not written", async () => {
    ageResult = { error: { status: 500, message: "down" } };
    const target = await run();
    expect(target.startsWith("/account?error=")).toBe(true);
    expect(target).not.toBe(AGE_ERROR);
    expect(writerCreated).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

describe("author role write boundary (static)", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
  const read = (p: string) => readFileSync(path.join(root, p), "utf8");

  it("the writer module is server-only", () => {
    expect(read("src/lib/author-role-write-client.ts")).toMatch(/^import "server-only";/);
  });

  it("becomeAuthor and signup (SECURITY-9A) are the writer's only importers", () => {
    const out = execFileSync("grep", ["-rl", "author-role-write-client", "src"], { cwd: root, encoding: "utf8" });
    const importers = out
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.endsWith(".test.ts") && f !== "src/lib/author-role-write-client.ts");
    expect(importers.sort()).toEqual(["src/app/(public)/account/become-author.ts", "src/app/(public)/auth/actions.ts"]);
  });
});

// SECURITY-9A (Renato, "2. a" after the r1 audit): "Become an author"
// always needs the Terms tick too, and records it. A reader made by
// calling Supabase Auth directly never saw the sign-up's Terms tick.
describe("becomeAuthor: SECURITY-9A Terms tick", () => {
  const TERMS_ERROR = `/account?error=${encodeURIComponent(
    "You must agree to the Terms of Service before becoming an author.",
  )}`;

  it.each([
    ["no Terms tick", undefined],
    ["a Terms tick with another value", "yes"],
  ])("%s (18+ ticked): refused, nothing recorded or written", async (_label, value) => {
    const formData = new FormData();
    formData.set("confirm_author_age", "on");
    if (value !== undefined) formData.set("accept_terms", value);
    expect(await run(formData)).toBe(TERMS_ERROR);
    expect(ageCalls).toHaveLength(0);
    expect(writerCreated).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("both ticks: one record with the Terms and 18+ fields only, then the role write", async () => {
    expect((await run()).startsWith("/dashboard?success=")).toBe(true);
    expect(Object.keys(ageCalls[0].attributes.app_metadata ?? {}).sort()).toEqual([
      "author_age_confirmed_at",
      "author_age_statement_version",
      "terms_accepted_at",
      "terms_version",
    ]);
    expect(order).toEqual(["age", "role"]);
  });
});
