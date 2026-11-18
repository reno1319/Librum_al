import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// DEL: the second describe below covers the deletion request itself
// (request_account_deletion); the final deletion is tested in
// src/lib/account-deletion.*.test.ts.
//
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
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args) }));
// DEL: the email is sent through after(); the test runs the callback at
// once so it can see what was sent.
const afterCallbacks: Array<() => Promise<void> | void> = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => afterCallbacks.push(fn) }));
const mockSendEmail = vi.fn(() => Promise.resolve());
vi.mock("@/lib/email", () => ({
  sendAccountDeletionRequestedEmail: (...args: unknown[]) => mockSendEmail(...(args as [])),
}));

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
const mockSignOut = vi.fn(() => Promise.resolve({ error: null }));
const mockRpc = vi.fn((_name: string, _args: unknown) =>
  Promise.resolve({ data: "2026-12-18T10:00:00.000Z" as unknown, error: null as { code?: string; message: string } | null }),
);
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ auth: { getUser: mockGetUser, signOut: mockSignOut }, from: mockFrom, rpc: mockRpc }),
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
    mockRpc.mockClear();
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

    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toMatchObject({
      target: expect.stringContaining("/reset-password"),
    });

    expect(mockStaffLookup).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("unauthenticated: redirects to /login before ever querying staff_members", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toBeInstanceOf(
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

    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toMatchObject({
      target: "/account?error=Hiqeni%20k%C3%ABt%C3%AB%20llogari%20nga%20stafi%20i%20Librum%20para%20se%20ta%20fshini.",
    });
  });

  it("staff-lookup DATABASE ERROR: deletion is blocked, not fail-open -- ambiguity between 'not staff' and 'lookup failed' is not permitted", async () => {
    mockStaffLookup.mockResolvedValue({ data: null, error: { message: "connection refused" } });

    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toMatchObject({
      target: "/account?error=Nuk%20mund%C3%ABm%20t%C3%AB%20kontrollojm%C3%AB%20n%C3%ABse%20kjo%20llogari%20mund%20t%C3%AB%20fshihet.%20Provoni%20p%C3%ABrs%C3%ABri.",
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

    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// DEL (del1 a, del4 a, del5 a): the button asks for the deletion; it
// never deletes. The real deletion is the daily job's, 30 days later.
describe("deleteAccount: the deletion request (30 days to undo)", () => {
  const USER = {
    id: "user-1",
    email: "reader@example.test",
    app_metadata: { provider: "email", providers: ["email"] },
  };

  beforeEach(() => {
    mockGetUser.mockReset().mockResolvedValue({ data: { user: USER } });
    mockStaffLookup.mockReset().mockResolvedValue({ data: null, error: null });
    mockCookieStore.get.mockReset().mockImplementation(() => undefined);
    mockRpc.mockReset().mockResolvedValue({ data: "2026-12-18T10:00:00.000Z", error: null });
    mockSignOut.mockClear();
    mockRevalidatePath.mockClear();
    mockSendEmail.mockReset().mockResolvedValue(undefined);
    mockCreateAdminClient.mockClear();
    mockDeleteUser.mockReset();
    afterCallbacks.length = 0;
  });

  async function runAfter() {
    for (const fn of afterCallbacks.splice(0)) await fn();
  }

  it("asks the database for the deletion with the reason and the trimmed note, signs out, and lands on the homepage with the date", async () => {
    await expect(
      deleteAccount(formData({ confirmation: "FSHI", reason: "no_books", reason_note: "  pak libra  " })),
    ).rejects.toMatchObject({ target: "/?account=deletion_requested&until=2026-12-18" });

    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith("request_account_deletion", { p_reason: "no_books", p_note: "pak libra" });
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
    // Nothing is deleted now.
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("the reason question is optional: no answer sends nulls", async () => {
    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).toHaveBeenCalledWith("request_account_deletion", { p_reason: null, p_note: null });
  });

  it("an unknown reason code is dropped, not sent", async () => {
    await expect(
      deleteAccount(formData({ confirmation: "FSHI", reason: "drop table" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).toHaveBeenCalledWith("request_account_deletion", { p_reason: null, p_note: null });
  });

  it("a note longer than 500 letters is refused before the database is asked", async () => {
    await expect(
      deleteAccount(formData({ confirmation: "FSHI", reason_note: "a".repeat(501) })),
    ).rejects.toMatchObject({
      target: `/account?error=${encodeURIComponent("Shkruani deri në 500 shkronja te «Doni të na tregoni më shumë?».")}`,
    });
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("a wrong confirmation word never asks the database", async () => {
    await expect(deleteAccount(formData({ confirmation: "fshi" }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each([
    ["LB520", "/account/restore"],
    ["LB519", `/account?error=${encodeURIComponent("Hiqeni këtë llogari nga stafi i Librum para se ta fshini.")}`],
    [
      "LB522",
      `/account?error=${encodeURIComponent(
        "Llogaria juaj nuk mund të fshihet ndërsa lexuesit kanë libra që keni botuar. Hiqini librat nga publikimi nëse nuk doni më t'i shisni.",
      )}`,
    ],
    ["LB523", `/account?error=${encodeURIComponent("Shkruani deri në 500 shkronja te «Doni të na tregoni më shumë?».")}`],
    ["XX000", `/account?error=${encodeURIComponent("Diçka shkoi keq gjatë fshirjes së llogarisë. Provoni përsëri.")}`],
  ])("database error %s redirects to %s and does not sign out or email", async (code, target) => {
    mockRpc.mockResolvedValue({ data: null, error: { code, message: "raw database text" } });

    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toMatchObject({ target });

    expect(mockSignOut).not.toHaveBeenCalled();
    await runAfter();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("an answer that is not a date is treated as a failure", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toMatchObject({
      target: `/account?error=${encodeURIComponent("Diçka shkoi keq gjatë fshirjes së llogarisë. Provoni përsëri.")}`,
    });
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("sends one email after the answer, with the password line for a password account", async () => {
    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockSendEmail).not.toHaveBeenCalled();
    await runAfter();
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      "reader@example.test",
      expect.objectContaining({ hasPassword: true, deleteOn: expect.any(String), requestedOn: expect.any(String) }),
    );
  });

  it("a Google-only account gets the email without the password line", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: { ...USER, app_metadata: { provider: "google", providers: ["google"] } } },
    });
    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toBeInstanceOf(RedirectSignal);
    await runAfter();
    expect(mockSendEmail).toHaveBeenCalledWith("reader@example.test", expect.objectContaining({ hasPassword: false }));
  });

  it("an email failure does not undo or block the request", async () => {
    mockSendEmail.mockRejectedValue(new Error("resend down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(deleteAccount(formData({ confirmation: "FSHI" }))).rejects.toMatchObject({
      target: "/?account=deletion_requested&until=2026-12-18",
    });
    await expect(runAfter()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
