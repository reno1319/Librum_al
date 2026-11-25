import { beforeEach, describe, expect, it, vi } from "vitest";

// LR1 patch 2 (lr2-1 a): removeOnlyOnLibrum. requireStaff and redirect
// are mocked; a redirect is modelled as the throw Next really does.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
const revalidated: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.push(p) }));

let rpcResult: { data: unknown; error: { message: string } | null };
const rpcCalls: { name: string; args: unknown }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string, args: unknown) => (rpcCalls.push({ name, args }), Promise.resolve(rpcResult)),
    }),
}));

const { removeOnlyOnLibrum } = await import("./only-on-librum-actions");
const BOOK = "22222222-2222-4222-8222-222222222222";

async function target(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return decodeURIComponent(e.message);
    throw e;
  }
  throw new Error("no redirect");
}

describe("removeOnlyOnLibrum", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRequireStaff.mockResolvedValue({ userId: "staff-1", role: "owner" });
    rpcCalls.length = 0;
    revalidated.length = 0;
    rpcResult = { data: true, error: null };
  });

  it("checks catalog.feature first, then calls the audited database function with the session", async () => {
    expect(await target(removeOnlyOnLibrum(BOOK))).toBe(`/admin/books/${BOOK}?success=Removed from the “only on Librum” shelf.`);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([{ name: "staff_remove_only_on_librum", args: { p_book_id: BOOK } }]);
    expect(revalidated).toEqual(expect.arrayContaining([`/admin/books/${BOOK}`, "/librari"]));
  });

  it("a refused staff check calls nothing", async () => {
    mockRequireStaff.mockRejectedValue(new RedirectSignal("/admin"));
    expect(await target(removeOnlyOnLibrum(BOOK))).toBe("/admin");
    expect(rpcCalls).toEqual([]);
  });

  it("a bad id calls nothing", async () => {
    expect(await target(removeOnlyOnLibrum("nope"))).toBe("/admin/books");
    expect(rpcCalls).toEqual([]);
  });

  it("not ticked any more, or an error, says so", async () => {
    rpcResult = { data: false, error: null };
    expect(await target(removeOnlyOnLibrum(BOOK))).toBe(`/admin/books/${BOOK}?error=This book isn’t ticked “only on Librum” any more.`);
    rpcResult = { data: null, error: { message: "boom" } };
    expect(await target(removeOnlyOnLibrum(BOOK))).toBe(`/admin/books/${BOOK}?error=Couldn’t remove it from the shelf. Please try again.`);
  });
});
