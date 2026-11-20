import { beforeEach, describe, expect, it, vi } from "vitest";

// ALERTS-2: the owner's test link throws on purpose (so onRequestError
// emails it); everyone else gets a plain not-found.
const getStaffMember = vi.hoisted(() => vi.fn());
vi.mock("@/lib/staff", () => ({ getStaffMember }));
const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
);
vi.mock("next/navigation", () => ({ notFound }));

const { GET } = await import("./route");
const { TEST_ERROR_MESSAGE } = await import("@/lib/error-alerts");

beforeEach(() => {
  getStaffMember.mockReset();
  notFound.mockClear();
});

describe("owner test error link", () => {
  it("throws the test error for the staff owner", async () => {
    getStaffMember.mockResolvedValue({ userId: "u1", role: "owner" });
    await expect(GET()).rejects.toThrow(TEST_ERROR_MESSAGE);
    expect(notFound).not.toHaveBeenCalled();
  });

  it("says plainly that nothing is broken", () => {
    expect(TEST_ERROR_MESSAGE).toContain("Nothing is broken");
  });

  it.each(["admin", "editor", "moderator", "support"])("is not found for staff role %s", async (role) => {
    getStaffMember.mockResolvedValue({ userId: "u1", role });
    await expect(GET()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it("is not found for a visitor or a signed-in non-staff user", async () => {
    getStaffMember.mockResolvedValue(null);
    await expect(GET()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
