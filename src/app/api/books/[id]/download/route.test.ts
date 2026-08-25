import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to this Route Handler -- not a re-test of its own
// pre-existing ownership/entitlement logic (that stays untouched and
// uncovered here). Uses a 403 JSON response, not a redirect, per the
// audit's own conclusion for API/download-shaped endpoints -- see the
// route's own comment.
const mockCookieStore = {
  get: vi.fn((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined)),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
const mockWatermarkEpub = vi.fn();
vi.mock("@/lib/watermark", () => ({ watermarkEpub: () => mockWatermarkEpub() }));

const { GET } = await import("./route");

describe("GET /api/books/[id]/download: recovery-session defense-in-depth", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockWatermarkEpub.mockClear();
  });

  it("returns 403 and never reaches Supabase when a recovery session is active", async () => {
    const response = await GET(
      new Request("https://librumal.vercel.app/api/books/book-1/download"),
      { params: Promise.resolve({ id: "book-1" }) },
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toMatch(/password/i);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockWatermarkEpub).not.toHaveBeenCalled();
  });
});
