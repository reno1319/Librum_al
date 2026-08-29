import { describe, expect, it, vi, beforeEach } from "vitest";

// ADMIN-1A.5 "ADMIN REDIRECT CONTRACT": requireStaff()'s unauthenticated
// redirect-URL construction, isolated in its own file (unlike
// src/lib/staff.test.ts, which deliberately keeps decideStaffAccess()'s
// pure-function tests free of any Next.js mocking -- this file needs
// next/headers, next/navigation, and @/lib/supabase/server all mocked,
// which would change that file's own character). resolveSafeAdminPath()
// itself is real, not mocked -- this exercises the actual integration
// between requireStaff() and it, not just requireStaff()'s own plumbing.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockHeadersGet = vi.fn(() => null as string | null);
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve({ get: () => mockHeadersGet() }),
}));

const mockGetUser = vi.fn(() =>
  Promise.resolve({ data: { user: null as { id: string } | null } }),
);
const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
      }),
    }),
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { requireStaff } = await import("./staff");

describe("requireStaff: unauthenticated redirect contract", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockHeadersGet.mockReset();
    mockHeadersGet.mockImplementation(() => null);
    mockGetUser.mockClear();
    mockGetUser.mockResolvedValue({ data: { user: null } });
  });

  it("/admin logged out -> /admin/login (no next -- /admin is already the plain fallback)", async () => {
    mockHeadersGet.mockImplementation(() => "/admin");

    await expect(requireStaff("admin.access")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
  });

  it("/admin/reports logged out -> /admin/login?next=/admin/reports (safe destination preserved)", async () => {
    mockHeadersGet.mockImplementation(() => "/admin/reports");

    await expect(requireStaff("reports.view")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login?next=%2Fadmin%2Freports");
  });

  it("/admin/refunds logged out -> /admin/login?next=/admin/refunds (safe destination preserved)", async () => {
    mockHeadersGet.mockImplementation(() => "/admin/refunds");

    await expect(requireStaff("refunds.view")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login?next=%2Fadmin%2Frefunds");
  });

  it("missing/absent pathname header -> plain /admin/login, no next", async () => {
    mockHeadersGet.mockImplementation(() => null);

    await expect(requireStaff("admin.access")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
  });

  it("a non-admin pathname somehow forwarded (defensive case) is rejected by resolveSafeAdminPath -- falls back to plain /admin/login, never leaks a non-/admin next", async () => {
    mockHeadersGet.mockImplementation(() => "/dashboard");

    await expect(requireStaff("admin.access")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
  });

  it("forbidden (authenticated, lacking the permission) still redirects to / -- unchanged by this correction", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockCreateClient.mockResolvedValueOnce({
      auth: { getUser: mockGetUser },
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: { role: "moderator" } }) }),
        }),
      }),
    } as never);

    await expect(requireStaff("refunds.resolve")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith("/");
  });
});
