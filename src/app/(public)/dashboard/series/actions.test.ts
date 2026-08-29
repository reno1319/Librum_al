import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: focused coverage of createSeries's
// one ERR-2 site (the series insert). No prior test file existed for
// this actions module.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockGetUser = vi.fn();
const mockInsertSeries = vi.fn();

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table !== "series") throw new Error(`unexpected table in this focused test: ${table}`);
      return { insert: () => mockInsertSeries() };
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { createSeries } = await import("./actions");

describe("createSeries: ERR-2 error-message mapping", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "author-1" } } });
    mockInsertSeries.mockReset();
  });

  it("maps a raw Postgres/PostgREST error to a stable Librum-facing message, never error.message", async () => {
    const formData = new FormData();
    formData.set("title", "The Chronicles");
    mockInsertSeries.mockResolvedValue({
      error: { message: 'new row violates row-level security policy for table "series"' },
    });

    await expect(createSeries(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("We couldn't create the series. Please try again."),
    );
    expect(redirectedTo).not.toContain("row-level security");
  });

  it("still redirects with the existing, Librum-authored validation message for a blank title -- untouched by ERR-2", async () => {
    const formData = new FormData();
    formData.set("title", "   ");

    await expect(createSeries(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("error=Please+enter+a+series+title"),
    );
    expect(mockInsertSeries).not.toHaveBeenCalled();
  });
});
