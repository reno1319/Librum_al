import { describe, expect, it, vi, beforeEach } from "vitest";
import type { User } from "@supabase/supabase-js";

// K7: what the first Google sign-in writes. Service-role writes are
// mocked at the client boundary, like auth/actions.test.ts.
const calls: string[] = [];
let profileUpdate: { values: unknown; id: unknown } | null = null;
let profileError: unknown = null;
const mockRecord = vi.fn(async (_id: string, _opts: unknown) => {
  calls.push("record");
  return recordOk;
});
let recordOk = true;
const mockSwitch = vi.fn(async (_id: string, _name: string, _kind?: string) => {
  calls.push("switch");
  return switchOk;
});
let switchOk = true;

vi.mock("@/lib/agreement-records", () => ({ recordAgreements: (id: string, o: unknown) => mockRecord(id, o) }));
vi.mock("@/lib/author-signup-switch", () => ({
  switchNewAccountToAuthor: (id: string, n: string, k?: string) => mockSwitch(id, n, k),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      update: (values: unknown) => ({
        eq: async (_c: string, id: unknown) => {
          calls.push(`name:${table}`);
          profileUpdate = { values, id };
          return { error: profileError };
        },
      }),
    }),
  }),
}));

const { finishGoogleSignIn, googleDisplayName } = await import("./google-sign-in");

const ID = "66666666-6666-4666-8666-666666666666";
function user(over: Partial<User> = {}): User {
  return {
    id: ID,
    aud: "authenticated",
    created_at: "2026-11-16T00:00:00Z",
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: { full_name: "  Ana Hoxha  ", name: "Ana" },
    identities: [{ provider: "google" }],
    ...over,
  } as unknown as User;
}

beforeEach(() => {
  calls.length = 0;
  profileUpdate = null;
  profileError = null;
  recordOk = true;
  switchOk = true;
  mockRecord.mockClear();
  mockSwitch.mockClear();
});

describe("googleDisplayName", () => {
  it("prefers full_name, trims, falls back to name, cuts to 120", () => {
    expect(googleDisplayName(user())).toBe("Ana Hoxha");
    expect(googleDisplayName(user({ user_metadata: { name: "Ana" } }))).toBe("Ana");
    expect(googleDisplayName(user({ user_metadata: { full_name: "   " } }))).toBeNull();
    expect(googleDisplayName(user({ user_metadata: {} }))).toBeNull();
    expect(googleDisplayName(user({ user_metadata: { full_name: "x".repeat(200) } }))).toHaveLength(120);
  });
});

describe("finishGoogleSignIn", () => {
  it("new Google reader: Google name saved, Terms recorded as google_notice, no 18+, no switch", async () => {
    expect(await finishGoogleSignIn(user(), false)).toBe("reader");
    expect(profileUpdate).toEqual({ values: { display_name: "Ana Hoxha" }, id: ID });
    expect(mockRecord).toHaveBeenCalledWith(ID, { authorAge: false, viaGoogleNotice: true });
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it("new Google author: name, then both records, then the switch with the Google name", async () => {
    expect(await finishGoogleSignIn(user(), true)).toBe("author");
    expect(calls).toEqual(["name:profiles", "record", "switch"]);
    expect(mockRecord).toHaveBeenCalledWith(ID, { authorAge: true, viaGoogleNotice: true });
    expect(mockSwitch).toHaveBeenCalledWith(ID, "Ana Hoxha", "person");
  });

  // BUILD 2a-1 (h2 b): the house hint switches to a house author account
  // with the Terms record only (no 18+ tick for houses).
  it("new Google publishing house: name, Terms record without 18+, then the house switch", async () => {
    expect(await finishGoogleSignIn(user(), true, "publishing_house")).toBe("author");
    expect(calls).toEqual(["name:profiles", "record", "switch"]);
    expect(mockRecord).toHaveBeenCalledWith(ID, { authorAge: false, viaGoogleNotice: true });
    expect(mockSwitch).toHaveBeenCalledWith(ID, "Ana Hoxha", "publishing_house");
  });

  it("the house kind without the author hint is a plain reader", async () => {
    expect(await finishGoogleSignIn(user(), false, "publishing_house")).toBe("reader");
    expect(mockRecord).toHaveBeenCalledWith(ID, { authorAge: false, viaGoogleNotice: true });
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it("author: a failed record or switch ends as a reader (author_failed), never an author without the 18+ record", async () => {
    recordOk = false;
    expect(await finishGoogleSignIn(user(), true)).toBe("author_failed");
    expect(mockSwitch).not.toHaveBeenCalled();
    recordOk = true;
    switchOk = false;
    expect(await finishGoogleSignIn(user(), true)).toBe("author_failed");
  });

  it("author without any Google name: no switch (no public name from the address)", async () => {
    expect(await finishGoogleSignIn(user({ user_metadata: {} }), true)).toBe("author_failed");
    expect(profileUpdate).toBeNull();
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it("a name write error is logged and sign-in goes on", async () => {
    profileError = { code: "XX" };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await finishGoogleSignIn(user(), false)).toBe("reader");
    expect(log).toHaveBeenCalledWith("google sign-in: name not saved", { code: "XX" });
    expect(JSON.stringify(log.mock.calls)).not.toContain(ID);
    log.mockRestore();
  });

  it.each([
    ["already has a Terms record (signed in with Google before)", user({ app_metadata: { terms_accepted_at: "2026-11-01" } })],
    ["has an email/password identity (Gmail linked to a form account)", user({ identities: [{ provider: "email" }, { provider: "google" }] as User["identities"] })],
    ["has no Google identity", user({ identities: [{ provider: "email" }] as User["identities"] })],
  ])("left exactly as it is when it %s, even with the author hint", async (_l, u) => {
    expect(await finishGoogleSignIn(u, true)).toBe("reader");
    expect(calls).toEqual([]);
  });
});
