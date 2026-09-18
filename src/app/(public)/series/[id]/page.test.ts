import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// APP A EXHAUSTIVE AUDIT: this page's own comment states "BookCard
// already renders each book's real price" -- found by the exhaustive
// schema-sensitive route audit, not listed in V3 §3's own inventory.
// getPublicSeriesPageData() (shared by generateMetadata() and the page
// component) selects books.*, including price_cents -- this file
// exists solely to prove the maintenance gate blocks both entry points
// at runtime.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: SeriesPage, generateMetadata } = await import("./page");

const SERIES_ID = "11111111-1111-4111-8111-111111111111";
function pageArgs() {
  return { params: Promise.resolve({ id: SERIES_ID }) };
}

describe("SeriesPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await SeriesPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no series id, book price, or other configuration/identifier value", async () => {
    const element = await SeriesPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toContain(SERIES_ID);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("generateMetadata returns {} and performs zero Supabase calls, same as its own not-public fallback", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ id: SERIES_ID }) });
    expect(metadata).toEqual({});
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(SeriesPage(pageArgs())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalled();
  });
});
