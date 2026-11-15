import { beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_ERRORS } from "@/lib/reader-feedback";

// K4 feedback button: the "Dërgo" server action.
let user: { id: string } | null = null;
let rpcResult: { error: { code?: string } | null } = { error: null };
const rpc = vi.fn(async (..._args: unknown[]) => rpcResult);
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user } }) }, rpc }),
}));

const { sendFeedback } = await import("./feedback-actions");

beforeEach(() => {
  user = { id: "00000000-0000-4000-8000-0000000000b2" };
  rpcResult = { error: null };
  rpc.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sendFeedback", () => {
  it("sends the trimmed text, the kind and the page path (no query) as the reader", async () => {
    expect(await sendFeedback("problem", "  Nuk punon.  ", "/libra/x?y=1")).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("submit_reader_feedback", { p_kind: "problem", p_body: "Nuk punon.", p_page_path: "/libra/x" });
  });

  it("checks first, without calling the database", async () => {
    expect(await sendFeedback("bug", "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.kind });
    expect(await sendFeedback("idea", "  ", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.empty });
    expect(await sendFeedback("idea", "a".repeat(1001), "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.long });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("refuses a signed-out caller", async () => {
    user = null;
    expect(await sendFeedback("idea", "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.signedOut });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("turns the database refusals into words", async () => {
    rpcResult = { error: { code: "LB514" } };
    expect(await sendFeedback("idea", "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.tooMany });
    rpcResult = { error: { code: "LB510" } };
    expect(await sendFeedback("idea", "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.suspended });
    rpcResult = { error: {} };
    expect(await sendFeedback("idea", "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.failed });
  });
});
