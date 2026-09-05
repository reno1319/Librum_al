import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// AUTH-1C: minimal, focused coverage of ONLY the recovery guards added
// to publishBook()/unpublishBook()/deleteBook() -- mirrors the existing
// "recovery-session defense-in-depth" pattern already established for
// buyBundle (src/app/bundles/[id]/actions.test.ts) and buyBook
// (src/app/books/[id]/actions.test.ts). Deliberately a separate file
// from actions.test.ts, which has its own narrow, table-scoped Supabase
// mock ("throw on any unexpected table") built for createBook()/
// updateBook()'s own bibliographic-metadata coverage.
//
// unpublishBook()/deleteBook() place their guard as the literal first
// line (before createClient() is even called), matching buyBook's/
// buyBundle's own placement -- for those, "never touches Supabase" is
// asserted directly. publishBook()'s guard lives inside the shared
// performPublish() helper (also used by createBook()'s own
// intent=publish branch), which runs AFTER publishBook()'s own auth
// check -- so its test instead proves the actual publish MUTATION
// (books.update) never happens, which is what Section 8 of the AUTH-1C
// brief actually requires ("before... the publish/unpublish mutation").
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

const mockCookieStore = {
  get: vi.fn((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined)),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockGetUser = vi.fn();
const mockFrom = vi.fn();
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ auth: { getUser: mockGetUser }, from: mockFrom }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const { publishBook, unpublishBook, deleteBook } = await import("./actions");

describe("publishBook/unpublishBook/deleteBook: recovery-session defense-in-depth (AUTH-1C)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "author-1" } } });
    mockFrom.mockReset();
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );
  });

  it("publishBook: redirects to /reset-password and never mutates the books table when a recovery session is active", async () => {
    await expect(publishBook("book-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("unpublishBook: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(unpublishBook("book-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteBook: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(deleteBook("book-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("no active recovery session: publishBook proceeds past the guard and reaches the books table", async () => {
    mockCookieStore.get.mockImplementation(() => undefined);
    mockFrom.mockImplementation((table: string) => {
      if (table !== "books") throw new Error(`unexpected table: ${table}`);
      return { select: () => ({ eq: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }) }) };
    });

    // "not_found" (no such book, or not owned by this user) is
    // publishBook()'s own pre-existing behavior once it actually reaches
    // performPublish() -- proving the guard did NOT fire (it would have
    // redirected to "/reset-password" instead) and that the books table
    // was genuinely queried.
    await expect(publishBook("book-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockFrom).toHaveBeenCalledWith("books");
  });
});
