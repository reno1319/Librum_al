import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 LAUNCH-FIX-1A ERR-2: focused coverage of addContributor's
// one ERR-2 site (the book_contributors insert) -- a separate file from
// actions.test.ts's own narrow, pre-existing scope (see that file's own
// header comment), with its own minimal mock Supabase client.
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
const mockBookOwnershipSingle = vi.fn();
const mockInsertContributor = vi.fn();

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "books") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => mockBookOwnershipSingle(),
              }),
            }),
          }),
        };
      }
      if (table === "book_contributors") {
        return { insert: () => mockInsertContributor() };
      }
      throw new Error(`unexpected table in this focused test: ${table}`);
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { addContributor } = await import("./actions");

describe("addContributor: ERR-2 error-message mapping", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "author-1" } } });
    mockBookOwnershipSingle.mockReset().mockResolvedValue({ data: { id: "book-1" } });
    mockInsertContributor.mockReset();
  });

  it("maps a raw Postgres/PostgREST error to a stable Librum-facing message, never error.message", async () => {
    const formData = new FormData();
    formData.set("name", "Jane Editor");
    formData.set("role", "Editor");
    mockInsertContributor.mockResolvedValue({
      error: { message: 'new row violates row-level security policy for table "book_contributors"' },
    });

    await expect(addContributor("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("We couldn't add the contributor. Please try again."),
    );
    expect(redirectedTo).not.toContain("row-level security");
  });

  it("still redirects with the existing, Librum-authored validation message for a missing name -- untouched by ERR-2", async () => {
    const formData = new FormData();
    formData.set("name", "");
    formData.set("role", "Editor");

    await expect(addContributor("book-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("error=Enter+a+name+and+choose+a+role"),
    );
    expect(mockInsertContributor).not.toHaveBeenCalled();
  });
});
