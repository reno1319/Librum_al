import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PEOPLE-2: Suspend, Lift and "Try again". Maintenance gate first, then
// requireStaff("people.manage"), then the form check, then the RPC on
// the staff member's OWN session; after it commits, the Supabase Auth
// ban (service role), then the email (address from the admin auth API
// only), and a failed ban says so plainly. The retry follows the
// account_suspensions row and never anything else.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args) }));

const mockRequireStaff = vi.fn((_permission: string) => Promise.resolve({ userId: "staff-1", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => Promise.resolve({ rpc: mockRpc }) }));

type Result = { data: unknown; error: unknown };
let suspensionRow: Result = { data: null, error: null };
const mockGetUserById = vi.fn();
const mockUpdateUserById = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        maybeSingle: () => Promise.resolve(table === "account_suspensions" ? suspensionRow : { data: null, error: null }),
      };
      return chain;
    },
    auth: {
      admin: {
        getUserById: (id: string) => mockGetUserById(id),
        updateUserById: (id: string, attrs: unknown) => mockUpdateUserById(id, attrs),
      },
    },
  }),
}));

const mockSuspendedEmail = vi.fn();
const mockLiftedEmail = vi.fn();
vi.mock("@/lib/email", () => ({
  sendAccountSuspendedEmail: (to: string) => mockSuspendedEmail(to),
  sendAccountSuspensionLiftedEmail: (to: string) => mockLiftedEmail(to),
}));

const { suspendAccountAsStaff, liftSuspensionAsStaff, retryAccountAccessAsStaff } = await import("./actions");

const ANA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PAGE = `/admin/people/${ANA}`;
const FUTURE = "2126-10-23T08:00:00Z";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectOf(run: () => Promise<unknown>): Promise<string> {
  await expect(run()).rejects.toBeInstanceOf(RedirectSignal);
  return String(mockRedirect.mock.calls.at(-1)?.[0]);
}

function messageOf(target: string, key: "error" | "success"): string | null {
  return new URL(target, "https://librum.test").searchParams.get(key);
}

beforeEach(() => {
  mockRedirect.mockClear();
  mockRevalidatePath.mockReset();
  mockRequireStaff.mockClear();
  mockRpc.mockReset().mockResolvedValue({ data: "suspension-1", error: null });
  mockGetUserById.mockReset().mockResolvedValue({ data: { user: { email: "ana@example.com" } }, error: null });
  mockUpdateUserById.mockReset().mockResolvedValue({ data: { user: {} }, error: null });
  mockSuspendedEmail.mockReset().mockResolvedValue(undefined);
  mockLiftedEmail.mockReset().mockResolvedValue(undefined);
  suspensionRow = { data: null, error: null };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("suspendAccountAsStaff", () => {
  it("is refused in maintenance before requireStaff", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("requires people.manage and refuses an empty reason without calling anything", async () => {
    const target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: " \n\t " })));
    expect(mockRequireStaff).toHaveBeenCalledWith("people.manage");
    expect(target.startsWith(`${PAGE}?error=`)).toBe(true);
    expect(messageOf(target, "error")).toBe("Write the reason for the suspension.");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("refuses a malformed id back to the list", async () => {
    const target = await redirectOf(() => suspendAccountAsStaff(form({ userId: "nope", reason: "Spam" })));
    expect(target.startsWith("/admin/people?error=")).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("calls the RPC on the staff session, then bans, then emails, then revalidates", async () => {
    const target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "  Spam books \n" })));
    expect(mockRpc).toHaveBeenCalledWith("admin_suspend_account", { p_user_id: ANA, p_reason: "Spam books" });
    expect(mockUpdateUserById).toHaveBeenCalledWith(ANA, { ban_duration: "876000h" });
    expect(mockGetUserById).toHaveBeenCalledWith(ANA);
    expect(mockSuspendedEmail).toHaveBeenCalledWith("ana@example.com");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/", "layout");
    expect(messageOf(target, "success")).toBe(
      "Account suspended. They're signed out, and their books are out of the Bookstore.",
    );
    const order = [
      mockRpc.mock.invocationCallOrder[0],
      mockUpdateUserById.mock.invocationCallOrder[0],
      mockSuspendedEmail.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("maps each RPC refusal and changes nothing else", async () => {
    for (const [message, expected] of [
      ["staff cannot be suspended", "Staff can't be suspended. Remove them from Staff first."],
      ["you cannot suspend yourself", "You can't suspend your own account."],
      ["this account is already suspended", "This account is already suspended."],
      ["no account found for this id", "This account no longer exists."],
      ["something unexpected", "Couldn't suspend the account. Nothing was changed. Try again."],
    ] as const) {
      mockRpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message } });
      const target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
      expect(messageOf(target, "error")).toBe(expected);
    }
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockSuspendedEmail).not.toHaveBeenCalled();
  });

  it("sends a signed-out staff member to the admin login", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "not authenticated" } });
    const target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
    expect(target).toBe(`/admin/login?next=${encodeURIComponent(PAGE)}`);
  });

  it("says plainly when the ban step fails after the RPC, and still emails", async () => {
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { code: "unexpected_failure" } });
    const target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
    expect(messageOf(target, "error")).toBe(
      "The account is suspended and its books are out of the Bookstore, but blocking sign-in failed. Use Try again below.",
    );
    expect(mockSuspendedEmail).toHaveBeenCalled();
  });

  it("a failed email or address read never fails the suspension", async () => {
    mockSuspendedEmail.mockRejectedValueOnce(new Error("resend down"));
    let target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
    expect(messageOf(target, "success")).not.toBeNull();
    mockGetUserById.mockRejectedValueOnce(new Error("auth down"));
    target = await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
    expect(messageOf(target, "success")).not.toBeNull();
  });

  it("never logs the email address", async () => {
    mockSuspendedEmail.mockRejectedValueOnce(new Error("resend down"));
    await redirectOf(() => suspendAccountAsStaff(form({ userId: ANA, reason: "Spam" })));
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls, (_k, v) => (v instanceof Error ? v.message : v));
    expect(logged).not.toContain("ana@example.com");
  });
});

describe("liftSuspensionAsStaff", () => {
  it("requires people.manage, lifts on the staff session, unbans, emails", async () => {
    mockRpc.mockResolvedValueOnce({ data: { restored_books: [] }, error: null });
    const target = await redirectOf(() => liftSuspensionAsStaff(form({ userId: ANA })));
    expect(mockRequireStaff).toHaveBeenCalledWith("people.manage");
    expect(mockRpc).toHaveBeenCalledWith("admin_lift_suspension", { p_user_id: ANA });
    expect(mockUpdateUserById).toHaveBeenCalledWith(ANA, { ban_duration: "none" });
    expect(mockLiftedEmail).toHaveBeenCalledWith("ana@example.com");
    expect(messageOf(target, "success")).toBe("Suspension lifted. They can sign in again.");
  });

  it("maps 'not suspended' and anything else (N2) without unbanning", async () => {
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "P0001", message: "this account is not suspended" } });
    let target = await redirectOf(() => liftSuspensionAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe("This account isn't suspended. Reload to see what changed.");
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "boom" } });
    target = await redirectOf(() => liftSuspensionAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe("Couldn't lift the suspension. Nothing was changed. Try again.");
    mockRpc.mockResolvedValueOnce({ data: null, error: { code: "40P01", message: "deadlock detected" } });
    target = await redirectOf(() => liftSuspensionAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe("Please try again.");
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(mockLiftedEmail).not.toHaveBeenCalled();
  });

  it("says plainly when the unban step fails", async () => {
    mockUpdateUserById.mockRejectedValueOnce(new Error("network"));
    const target = await redirectOf(() => liftSuspensionAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe(
      "The suspension is lifted, but allowing sign-in again failed. Use Try again below.",
    );
  });

  it("is refused in maintenance and on a malformed id", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    await redirectOf(() => liftSuspensionAsStaff(form({ userId: ANA })));
    expect(mockRequireStaff).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    const target = await redirectOf(() => liftSuspensionAsStaff(form({ userId: "x" })));
    expect(target.startsWith("/admin/people?error=")).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("retryAccountAccessAsStaff", () => {
  it("requires people.manage and bans only when an active suspension row exists", async () => {
    suspensionRow = { data: { id: "s1" }, error: null };
    mockGetUserById.mockResolvedValueOnce({ data: { user: { banned_until: null } }, error: null });
    const target = await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(mockRequireStaff).toHaveBeenCalledWith("people.manage");
    expect(mockUpdateUserById).toHaveBeenCalledWith(ANA, { ban_duration: "876000h" });
    expect(messageOf(target, "success")).toBe("Sign-in now matches the account's status.");
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSuspendedEmail).not.toHaveBeenCalled();
  });

  it("unbans only when no active suspension row exists", async () => {
    mockGetUserById.mockResolvedValueOnce({ data: { user: { banned_until: FUTURE } }, error: null });
    await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(mockUpdateUserById).toHaveBeenCalledWith(ANA, { ban_duration: "none" });
  });

  it("does nothing when they already agree", async () => {
    suspensionRow = { data: { id: "s1" }, error: null };
    mockGetUserById.mockResolvedValueOnce({ data: { user: { banned_until: FUTURE } }, error: null });
    let target = await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "success")).not.toBeNull();
    suspensionRow = { data: null, error: null };
    mockGetUserById.mockResolvedValueOnce({ data: { user: {} }, error: null });
    target = await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "success")).not.toBeNull();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("changes nothing when either read fails", async () => {
    suspensionRow = { data: null, error: { code: "XX000" } };
    mockGetUserById.mockResolvedValueOnce({ data: { user: { banned_until: FUTURE } }, error: null });
    let target = await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe("Couldn't update sign-in. Please try again.");
    suspensionRow = { data: { id: "s1" }, error: null };
    mockGetUserById.mockResolvedValueOnce({ data: { user: null }, error: { code: "user_not_found" } });
    target = await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe("Couldn't update sign-in. Please try again.");
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("reports a failed ban step", async () => {
    suspensionRow = { data: { id: "s1" }, error: null };
    mockGetUserById.mockResolvedValueOnce({ data: { user: {} }, error: null });
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { code: "unexpected_failure" } });
    const target = await redirectOf(() => retryAccountAccessAsStaff(form({ userId: ANA })));
    expect(messageOf(target, "error")).toBe("Couldn't update sign-in. Please try again.");
  });
});
