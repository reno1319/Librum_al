import { beforeEach, describe, expect, it, vi } from "vitest";

// PEN-NAMES-1 (4a, 8a): follow/unfollow target a pen name id; the author
// never follows their own pen name; Remove links is gated on
// reports.resolve before the database function is reached.

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Call = { table: string; ops: { method: string; args: unknown[] }[] };
let calls: Call[] = [];
let rpcCalls: { fn: string; args: unknown }[] = [];
let ownRow: unknown = null;
let staff = false;
let userId: string | null = "aaaaaaaa-0000-4000-8000-000000000002";

const supabase = {
  auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
  from(table: string) {
    const call: Call = { table, ops: [] };
    calls.push(call);
    const proxy: object = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (ok: (v: unknown) => unknown) =>
              Promise.resolve({ data: table === "pen_names" ? ownRow : null, error: null }).then(ok);
          }
          return (...args: unknown[]) => {
            call.ops.push({ method: String(prop), args });
            return proxy;
          };
        },
      },
    );
    return proxy;
  },
  rpc: async (fn: string, args: unknown) => (rpcCalls.push({ fn, args }), { error: null }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => supabase }));
vi.mock("@/lib/staff", () => ({ hasPermission: async (p: string) => staff && p === "reports.resolve" }));

const { followPenName, unfollowPenName, removePenNameLinks } = await import("./actions");

const PEN = "bbbbbbbb-0000-4000-8000-00000000000a";

async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof RedirectSignal) return decodeURIComponent(e.target);
    throw e;
  }
}

beforeEach(() => {
  calls = [];
  rpcCalls = [];
  ownRow = null;
  staff = false;
  userId = "aaaaaaaa-0000-4000-8000-000000000002";
});

describe("followPenName / unfollowPenName", () => {
  it("inserts a pen_name_follows row for the session user and the pen name id", async () => {
    expect(await redirectOf(followPenName(PEN))).toBeNull();
    const insert = calls.find((c) => c.table === "pen_name_follows")!;
    expect(insert.ops).toEqual([{ method: "insert", args: [{ follower_id: userId, pen_name_id: PEN }] }]);
    expect(calls.some((c) => c.table === "author_follows")).toBe(false);
  });

  it("one of the author's own pen names: no follow row", async () => {
    ownRow = { id: PEN };
    expect(await redirectOf(followPenName(PEN))).toBe(`/autore/${PEN}`);
    expect(calls.some((c) => c.table === "pen_name_follows")).toBe(false);
  });

  it("signed out goes to login; a malformed id touches nothing", async () => {
    userId = null;
    expect(await redirectOf(followPenName(PEN))).toBe(`/login?next=/autore/${PEN}`);
    expect(await redirectOf(followPenName("x'; drop"))).toBe("/");
    expect(calls).toEqual([]);
  });

  it("unfollow deletes only the session user's row for that pen name", async () => {
    await redirectOf(unfollowPenName(PEN));
    const del = calls.find((c) => c.table === "pen_name_follows")!;
    expect(del.ops).toEqual([
      { method: "delete", args: [] },
      { method: "eq", args: ["follower_id", userId] },
      { method: "eq", args: ["pen_name_id", PEN] },
    ]);
  });
});

describe("removePenNameLinks (8a)", () => {
  it("without reports.resolve: no RPC", async () => {
    expect(await redirectOf(removePenNameLinks(PEN))).toBe(`/autore/${PEN}`);
    expect(rpcCalls).toEqual([]);
  });

  it("with reports.resolve: calls staff_remove_pen_name_links for that pen name", async () => {
    staff = true;
    expect(await redirectOf(removePenNameLinks(PEN))).toBe(`/autore/${PEN}?success=Links removed.`);
    expect(rpcCalls).toEqual([{ fn: "staff_remove_pen_name_links", args: { p_pen_name_id: PEN } }]);
  });
});
