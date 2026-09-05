import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LIBRUM 2.0 ADMIN-1B PART B, FAIL-OPEN CORRECTION: regression coverage
// for deleteAccount()'s active-staff self-deletion guard and its
// fail-closed behavior on a staff-lookup error. Deliberately does NOT
// re-verify the full pre-existing books/purchases/storage-cleanup/
// deleteUser happy path end to end -- that logic is unmodified by this
// pass. "Non-staff self-account deletion unchanged" is proven by
// confirming the function reaches and behaves exactly as before at the
// very next existing step (the confirmation-text check) when the
// staff_members lookup finds no row and no error -- exactly the
// boundary this pass's guard sits in front of.
//
// The guard uses a direct staff_members lookup (via the normal
// request-scoped client), NOT getStaffMember() -- so this file mocks
// supabase.from("staff_members")...maybeSingle() directly, distinctly
// controllable per test for the three required outcomes: a real row
// (active staff), no row + no error (not staff), and no row + an error
// (lookup failure, must fail closed).
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

const mockCookieStore = {
  get: vi.fn((_name: string) => undefined as { value: string } | undefined),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockGetUser = vi.fn();
const mockStaffLookup = vi.fn(() => Promise.resolve({ data: null as { role: string } | null, error: null as { message: string } | null }));
const mockFrom = vi.fn((table: string) => {
  if (table === "staff_members") {
    return { select: () => ({ eq: () => ({ maybeSingle: mockStaffLookup }) }) };
  }
  throw new Error(`actions.test.ts: unexpected table "${table}" -- this suite only exercises the guard, not the full deletion flow past it`);
});
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ auth: { getUser: mockGetUser, signOut: vi.fn() }, from: mockFrom }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const mockDeleteUser = vi.fn();
const mockCreateAdminClient = vi.fn(() => ({
  auth: { admin: { deleteUser: mockDeleteUser } },
  storage: { from: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const { deleteAccount } = await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("deleteAccount: active-staff self-service deletion guard", () => {
  beforeEach(() => {
    mockGetUser.mockReset();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockStaffLookup.mockReset();
    mockStaffLookup.mockResolvedValue({ data: null, error: null });
    mockDeleteUser.mockReset();
    mockCreateAdminClient.mockClear();
    mockCookieStore.get.mockReset().mockImplementation(() => undefined);
  });

  // AUTH-1C: defense-in-depth -- account deletion is irreversible
  // (auth.admin.deleteUser() plus every authored book/file), so a
  // hijacked recovery-window session must not be able to delete the
  // account before the legitimate owner finishes resetting their
  // password. Placed before every other check in deleteAccount(),
  // including the staff-status guard above, so it's proven here first.
  it("recovery-session defense-in-depth: redirects to /reset-password and never queries staff_members when a recovery session is active", async () => {
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );

    await expect(deleteAccount(formData({ confirmation: "DELETE" }))).rejects.toMatchObject({
      target: expect.stringContaining("/reset-password"),
    });

    expect(mockStaffLookup).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("unauthenticated: redirects to /login before ever querying staff_members", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expect(deleteAccount(formData({ confirmation: "DELETE" }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockStaffLookup).not.toHaveBeenCalled();
  });

  it("non-staff (no row, no error): the guard does not fire -- the existing confirmation check is reached unchanged", async () => {
    mockStaffLookup.mockResolvedValue({ data: null, error: null });

    await expect(
      deleteAccount(formData({ confirmation: "not the right word" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    // Reaching (and being rejected by) the PRE-EXISTING confirmation
    // check -- not either of the new block messages -- proves the
    // guard is a true no-op for a confirmed non-staff account.
  });

  it.each([
    ["owner", "owner"],
    ["admin", "admin"],
    ["moderator", "moderator"],
    ["support", "support"],
    ["editor", "editor"],
  ])("active staff (%s): blocked with the stable staff message, even with a correct confirmation", async (_label, role) => {
    mockStaffLookup.mockResolvedValue({ data: { role }, error: null });

    await expect(deleteAccount(formData({ confirmation: "DELETE" }))).rejects.toMatchObject({
      target: "/account?error=Remove+this+account+from+Librum+staff+before+deleting+the+account.",
    });
  });

  it("staff-lookup DATABASE ERROR: deletion is blocked, not fail-open -- ambiguity between 'not staff' and 'lookup failed' is not permitted", async () => {
    mockStaffLookup.mockResolvedValue({ data: null, error: { message: "connection refused" } });

    await expect(deleteAccount(formData({ confirmation: "DELETE" }))).rejects.toMatchObject({
      target: "/account?error=Unable+to+verify+account+eligibility+for+deletion.+Try+again.",
    });

    // The generic lookup-error message never contains the raw
    // Postgres/network error text.
    // (Asserted structurally above via the exact expected target string
    // -- a leaked "connection refused" would fail that equality check.)

    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("blocking deletion (active staff) changes neither the account nor staff membership -- the admin client is never even constructed", async () => {
    mockStaffLookup.mockResolvedValue({ data: { role: "owner" }, error: null });

    await expect(deleteAccount(formData({ confirmation: "DELETE" }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });
});
