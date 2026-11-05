import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// AUTH-1C: minimal, focused coverage of ONLY the recovery guards of
// unpublishBook()/deleteBook() -- mirrors the existing "recovery-session
// defense-in-depth" pattern already established for buyBundle
// (src/app/bundles/[id]/actions.test.ts) and buyBook
// (src/app/books/[id]/actions.test.ts).
//
// unpublishBook()/deleteBook() place their guard as the literal first
// line (before createClient() is even called), matching buyBook's/
// buyBundle's own placement -- for those, "never touches Supabase" is
// asserted directly. BD15 cleanup: publishBook is gone; the same guard
// inside performPublish() is now tested through saveBookPricing's Send
// (pricing-send.test.ts).
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

const { unpublishBook, deleteBook } = await import("./actions");

describe("unpublishBook/deleteBook: recovery-session defense-in-depth (AUTH-1C)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: "a1b2c3d4-1111-4111-8111-abcdef111111" } } });
    mockFrom.mockReset();
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );
  });

  it("unpublishBook: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(unpublishBook("c3d4e5f6-2222-4222-8222-abcdef222222")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteBook: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(deleteBook("c3d4e5f6-2222-4222-8222-abcdef222222")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
