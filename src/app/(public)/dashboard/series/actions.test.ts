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
const ownPenNames = ["pen-own"];

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "pen_names") {
        // PEN-NAMES-1: RLS shows only the caller's own pen names.
        const filters: Record<string, unknown> = {};
        const chain = {
          select: () => chain,
          eq: (c: string, v: unknown) => ((filters[c] = v), chain),
          maybeSingle: async () => ({
            data: filters.author_id === "author-1" && ownPenNames.includes(filters.id as string) ? { id: filters.id } : null,
          }),
        };
        return chain;
      }
      if (table !== "series") throw new Error(`unexpected table in this focused test: ${table}`);
      return { insert: (row: unknown) => mockInsertSeries(row) };
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
      encodeURIComponent("Seria nuk u krijua dot. Provoni përsëri."),
    );
    expect(redirectedTo).not.toContain("row-level security");
  });

  it("still redirects with the existing, Librum-authored validation message for a blank title -- untouched by ERR-2", async () => {
    const formData = new FormData();
    formData.set("title", "   ");

    await expect(createSeries(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("error=Shkruani%20titullin%20e%20seris%C3%AB"),
    );
    expect(mockInsertSeries).not.toHaveBeenCalled();
  });
});

describe("createSeries: PEN-NAMES-1 (11a) pen name", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "author-1" } } });
    mockInsertSeries.mockReset().mockResolvedValue({ error: null });
  });

  it("one of the author's own pen names is stored on the series", async () => {
    const formData = new FormData();
    formData.set("title", "Saga");
    formData.set("penNameId", "pen-own");
    await expect(createSeries(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockInsertSeries).toHaveBeenCalledWith({ author_id: "author-1", title: "Saga", pen_name_id: "pen-own" });
  });

  it("someone else's pen name id is refused before the insert", async () => {
    const formData = new FormData();
    formData.set("title", "Saga");
    formData.set("penNameId", "pen-other");
    await expect(createSeries(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("Zgjidhni një nga pseudonimet tuaja."));
    expect(mockInsertSeries).not.toHaveBeenCalled();
  });

  it("no pen name chosen: no pen_name_id sent (the database uses the default)", async () => {
    const formData = new FormData();
    formData.set("title", "Saga");
    await expect(createSeries(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockInsertSeries).toHaveBeenCalledWith({ author_id: "author-1", title: "Saga" });
  });
});
