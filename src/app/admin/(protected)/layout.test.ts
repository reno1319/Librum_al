import { describe, expect, it, vi, beforeEach } from "vitest";

// ADMIN-1A pre-finalize correction, item 10 ("editor cannot enter /admin
// at all"): the protected layout is the actual enforcement point for
// that -- proves it calls requireStaff("admin.access") and that a
// denial (which is exactly what happens for 'editor', per
// src/lib/staff-permissions.ts's empty permission set) stops rendering
// before any children mount.
//
// ADMIN-1A.5 FINAL ROUTING INVARIANT CORRECTION: this test file replaces
// the requireStaff()/AdminShell-wrapping coverage that used to live in
// src/app/admin/layout.test.ts, moved here because the logic itself
// moved to admin/(protected)/layout.tsx. The old file's third test ("/
// admin/login: never calls requireStaff() or AdminShell") is NOT carried
// forward -- it proved a runtime pathname exception that no longer
// exists. What replaces it structurally is simply that admin/login/
// page.tsx is never rendered as a child of THIS layout at all (it's a
// sibling directory, not nested under admin/(protected)/) -- see
// src/app/route-group-structure.test.ts for the directory-placement
// proof, and this layout's own file comment for the full "no redirect
// loop" reasoning.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn(
  (permission: string): Promise<{ userId: string; role: string }> => {
    throw new RedirectSignal(`/?denied=${permission}`);
  },
);
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

// JSX (`<AdminShell .../>`) only ever creates an inert element descriptor
// referencing this function as its `.type` -- it does NOT invoke it,
// since invocation is deferred to whenever a renderer walks the tree
// (which never happens in this direct-function-call test style). So the
// mock itself is asserted on via the returned element's `.type`/`.props`
// below, not via `.toHaveBeenCalledWith()`.
const mockAdminShell = vi.fn();
vi.mock("../admin-shell", () => ({ AdminShell: mockAdminShell }));

const { default: ProtectedAdminLayout } = await import("./layout");

describe("ProtectedAdminLayout (admin/(protected)/layout.tsx)", () => {
  beforeEach(() => {
    mockRequireStaff.mockClear();
    mockAdminShell.mockClear();
  });

  it("calls requireStaff('admin.access') and never renders children when denied", async () => {
    await expect(
      ProtectedAdminLayout({ children: "should never render" as unknown as React.ReactNode }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("admin.access");
  });

  it("wraps children in AdminShell with the resolved userId/role when authorized", async () => {
    mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role: "moderator" });

    const result = (await ProtectedAdminLayout({
      children: "content" as unknown as React.ReactNode,
    })) as unknown as { type: unknown; props: Record<string, unknown> };

    expect(result.type).toBe(mockAdminShell);
    expect(result.props).toEqual(
      expect.objectContaining({ userId: "staff-1", role: "moderator", children: "content" }),
    );
  });
});
