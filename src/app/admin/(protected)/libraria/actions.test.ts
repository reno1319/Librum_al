import { beforeEach, describe, expect, it, vi } from "vitest";

// LR1 patch 2 (lb5 a, lr2-3 a): saveCategoryButtons.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

let rpcResult: { data: unknown; error: { message: string } | null };
const rpcCalls: { name: string; args: unknown }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string, args: unknown) => (rpcCalls.push({ name, args }), Promise.resolve(rpcResult)),
    }),
}));

const { saveCategoryButtons } = await import("./actions");

async function target(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return decodeURIComponent(e.message);
    throw e;
  }
  throw new Error("no redirect");
}

function slots(values: string[]): FormData {
  const fd = new FormData();
  values.forEach((v, i) => fd.set(`slot${i + 1}`, v));
  return fd;
}

describe("saveCategoryButtons", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRequireStaff.mockResolvedValue({ userId: "staff-1", role: "owner" });
    rpcCalls.length = 0;
    rpcResult = { data: null, error: null };
  });

  it("checks catalog.feature, then saves the slots in order with the empty ones closed up", async () => {
    expect(await target(saveCategoryButtons(slots(["Poezi", "", "Histori", "", "", "Romancë"])))).toBe(
      "/admin/libraria?success=Category buttons saved.",
    );
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([{ name: "staff_set_libraria_category_buttons", args: { p_categories: ["Poezi", "Histori", "Romancë"] } }]);
  });

  it("all empty saves an empty list (the page falls back to A–Zh)", async () => {
    await target(saveCategoryButtons(slots(["", "", "", "", "", ""])));
    expect(rpcCalls).toEqual([{ name: "staff_set_libraria_category_buttons", args: { p_categories: [] } }]);
  });

  it("a repeat or an unknown category saves nothing", async () => {
    expect(await target(saveCategoryButtons(slots(["Poezi", "Poezi"])))).toBe("/admin/libraria?error=Choose each category only once.");
    expect(await target(saveCategoryButtons(slots(["Nope"])))).toBe(
      "/admin/libraria?error=Couldn’t save the category buttons. Please try again.",
    );
    expect(rpcCalls).toEqual([]);
  });

  it("a refused staff check calls nothing; a database error says so", async () => {
    mockRequireStaff.mockRejectedValueOnce(new RedirectSignal("/admin"));
    expect(await target(saveCategoryButtons(slots(["Poezi"])))).toBe("/admin");
    expect(rpcCalls).toEqual([]);
    rpcResult = { data: null, error: { message: "boom" } };
    expect(await target(saveCategoryButtons(slots(["Poezi"])))).toBe(
      "/admin/libraria?error=Couldn’t save the category buttons. Please try again.",
    );
  });
});
