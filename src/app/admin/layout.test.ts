import { describe, expect, it, vi } from "vitest";

// ADMIN-1A pre-finalize correction, item 10 ("editor cannot enter /admin
// at all"): the layout is the actual enforcement point for that -- proves
// it calls requireStaff("admin.access") and that a denial (which is
// exactly what happens for 'editor', per src/lib/staff-permissions.ts's
// empty permission set) stops rendering before any children mount.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn((permission: string) => {
  throw new RedirectSignal(`/?denied=${permission}`);
});
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const { default: AdminLayout } = await import("./layout");

describe("AdminLayout", () => {
  it("calls requireStaff('admin.access') and never renders children when denied", async () => {
    await expect(
      AdminLayout({ children: "should never render" as unknown as React.ReactNode }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("admin.access");
  });
});
