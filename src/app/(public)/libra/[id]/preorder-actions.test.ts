import { beforeEach, describe, expect, it, vi } from "vitest";

// BD16 P4: "Më njofto" / "Hiq" call P1's RPCs only, and send the reader
// back with words-only results.

const redirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT ${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const rpc = vi.fn();
let user: { id: string } | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

const { notifyMeWhenOut, removePreorderNotice } = await import("./preorder-actions");
const BOOK = "00000000-f1c9-4000-8000-000000001699";

beforeEach(() => {
  redirect.mockClear();
  rpc.mockReset();
  user = { id: "00000000-0000-4000-8000-0000000000b2" };
});

describe("notifyMeWhenOut", () => {
  it("calls preorder_notify_me and returns ?notify=on", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(notifyMeWhenOut(BOOK)).rejects.toThrow(`REDIRECT /libra/${BOOK}?notify=on`);
    expect(rpc).toHaveBeenCalledWith("preorder_notify_me", { p_book_id: BOOK });
  });
  it("already on the list (false) is still 'on'", async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(notifyMeWhenOut(BOOK)).rejects.toThrow("?notify=on");
  });
  it("a refusal (not a pre-order, LB508) is ?notify=error", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "LB508" } });
    await expect(notifyMeWhenOut(BOOK)).rejects.toThrow("?notify=error");
  });
  it("a visitor is sent to sign in, and nothing is called", async () => {
    user = null;
    await expect(notifyMeWhenOut(BOOK)).rejects.toThrow(`REDIRECT /login?next=/libra/${BOOK}`);
    expect(rpc).not.toHaveBeenCalled();
  });
  it("a malformed id calls nothing", async () => {
    await expect(notifyMeWhenOut("x/../y")).rejects.toThrow("REDIRECT /librari");
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("removePreorderNotice", () => {
  it("from the book page: preorder_notify_remove, back with ?notify=off", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(removePreorderNotice(BOOK, "book")).rejects.toThrow(`REDIRECT /libra/${BOOK}?notify=off`);
    expect(rpc).toHaveBeenCalledWith("preorder_notify_remove", { p_book_id: BOOK });
  });
  it("from the list: back to Njoftimet e mia, with ?notify=error on failure", async () => {
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(removePreorderNotice(BOOK, "list")).rejects.toThrow("REDIRECT /account/njoftimet");
    rpc.mockResolvedValue({ data: null, error: { code: "XX000" } });
    await expect(removePreorderNotice(BOOK, "list")).rejects.toThrow("REDIRECT /account/njoftimet?notify=error");
  });
});
