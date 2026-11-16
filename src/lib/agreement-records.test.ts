import { describe, expect, it, vi } from "vitest";

// K7: a Google sign-up's Terms record says it came from the line under
// the Google button; a ticked box's record is unchanged.
const mockUpdate = vi.fn(async (_id: string, _a: unknown) => ({ data: null, error: null }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { updateUserById: (id: string, a: unknown) => mockUpdate(id, a) } } }),
}));
const { recordAgreements, TERMS_VERSION } = await import("./agreement-records");

describe("recordAgreements terms_method (K7)", () => {
  it("viaGoogleNotice adds terms_method google_notice", async () => {
    await recordAgreements("u1", { authorAge: false, viaGoogleNotice: true });
    const meta = (mockUpdate.mock.calls.at(-1)?.[1] as { app_metadata: Record<string, unknown> }).app_metadata;
    expect(meta).toMatchObject({ terms_version: TERMS_VERSION, terms_method: "google_notice" });
    expect(meta).not.toHaveProperty("author_age_confirmed_at");
  });

  it("a ticked box (no option) writes no terms_method, as before", async () => {
    await recordAgreements("u1", { authorAge: true });
    const meta = (mockUpdate.mock.calls.at(-1)?.[1] as { app_metadata: Record<string, unknown> }).app_metadata;
    expect(meta).not.toHaveProperty("terms_method");
    expect(meta).toHaveProperty("author_age_confirmed_at");
  });
});
