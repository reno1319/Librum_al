import { beforeEach, describe, expect, it, vi } from "vitest";

// DEL (del2 b): the Restore button.
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
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => mockRevalidatePath(...a) }));

const mockGetUser = vi.fn();
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: mockGetUser }, rpc: mockRpc }),
}));

const { restoreAccount } = await import("./actions");

const GENERIC = `/account/restore?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri.")}`;

beforeEach(() => {
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "user-1" } } });
  mockRpc.mockReset().mockResolvedValue({ data: "restored", error: null });
  mockRevalidatePath.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("restoreAccount", () => {
  it("signed out: goes to /login without asking the database", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    await expect(restoreAccount()).rejects.toMatchObject({ target: "/login" });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([["restored"], ["not_pending"]])("%s: back to the Account page", async (answer) => {
    mockRpc.mockResolvedValue({ data: answer, error: null });
    await expect(restoreAccount()).rejects.toMatchObject({ target: "/account" });
    expect(mockRpc).toHaveBeenCalledWith("restore_my_account");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
  });

  it("too_late: the deletion has started and cannot be stopped", async () => {
    mockRpc.mockResolvedValue({ data: "too_late", error: null });
    await expect(restoreAccount()).rejects.toMatchObject({
      target: `/account/restore?error=${encodeURIComponent("Fshirja e llogarisë ka nisur dhe nuk mund të ndalet më.")}`,
    });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ data: null, error: { code: "XX000", message: "raw" } }],
    [{ data: "suspended", error: null }],
    [{ data: null, error: null }],
  ])("anything else is the generic error (%j)", async (answer) => {
    mockRpc.mockResolvedValue(answer);
    await expect(restoreAccount()).rejects.toMatchObject({ target: GENERIC });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });
});
