import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { hasLibrumMadeMarker, LIBRUM_MADE_EBOOK_METADATA, readLibrumMadeMarker } = await import("./ebook-cover-sync");
const { createClient } = await import("@supabase/supabase-js");

// The real client's storage (@supabase/storage-js), with only fetch faked.
function realStorage(fakeFetch: typeof fetch) {
  return createClient("https://dummyreffortestingx0.supabase.co", "test-only-key", {
    global: { fetch: fakeFetch },
    auth: { persistSession: false, autoRefreshToken: false },
  }).storage;
}

// W7 r2 (audit R2): the Librum-made Storage marker.
describe("hasLibrumMadeMarker", () => {
  it("is true only for librum exactly \"made\" in the object's custom metadata", () => {
    expect(LIBRUM_MADE_EBOOK_METADATA).toEqual({ librum: "made" });
    expect(hasLibrumMadeMarker({ metadata: LIBRUM_MADE_EBOOK_METADATA })).toBe(true);
    expect(hasLibrumMadeMarker({ userMetadata: { librum: "made" } })).toBe(true);
    for (const value of [
      {},
      null,
      undefined,
      "x",
      { metadata: null },
      { metadata: { librum: 1 } },
      { metadata: { librum: "Made" } },
      { metadata: { librum_made: "1" } },
      { metadata: { librumMade: "1" } },
      { librum: "made" },
    ]) {
      expect(hasLibrumMadeMarker(value)).toBe(false);
    }
  });
});

// r3 (audit B1): through the REAL @supabase/storage-js client, with only
// fetch faked -- the doubles elsewhere skip the client, which is how r2's
// "librum_made" key (camelized to "librumMade" by info()) went unnoticed.
describe("the marker through the real storage-js client", () => {
  const PATH = "a1b2c3d4-3333-4333-8333-abcdef333333/c3d4e5f6-5555-4555-8555-abcdef555555/0f0e0d0c-0b0a-4908-8706-050403020100.epub";

  function clientWith(respond: (url: string, init: RequestInit) => unknown, seen: { url: string; init: RequestInit }[]) {
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(respond(url, init ?? {})), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return realStorage(fakeFetch);
  }

  it("upload sends the marker as the x-metadata header", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const storage = clientWith(() => ({ Id: "id", Key: `manuscripts/${PATH}` }), seen);
    const { error } = await storage
      .from("manuscripts")
      .upload(PATH, Buffer.from("epub bytes"), { contentType: "application/epub+zip", metadata: { ...LIBRUM_MADE_EBOOK_METADATA } });
    expect(error).toBeNull();
    const headers = new Headers(seen[0].init.headers as HeadersInit);
    const header = headers.get("x-metadata");
    expect(header).not.toBeNull();
    expect(JSON.parse(Buffer.from(header!, "base64").toString("utf8"))).toEqual({ librum: "made" });
  });

  it("info() of a marked object reads as Librum-made (snake_case and camelCase responses)", async () => {
    for (const body of [
      { id: "1", name: PATH, metadata: { librum: "made" }, user_metadata: { librum: "made" } },
      { id: "1", name: PATH, user_metadata: { librum: "made" } },
      { id: "1", name: PATH, metadata: { librum: "made" } },
    ]) {
      const seen: { url: string; init: RequestInit }[] = [];
      expect(await readLibrumMadeMarker(clientWith(() => body, seen), PATH)).toBe("yes");
      expect(seen[0].url).toContain(`/object/info/manuscripts/${PATH}`);
    }
  });

  it("an unmarked object reads as not Librum-made, and r2's underscore key would have been lost", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    expect(await readLibrumMadeMarker(clientWith(() => ({ id: "1", name: PATH, metadata: {} }), seen), PATH)).toBe("no");
    expect(
      await readLibrumMadeMarker(clientWith(() => ({ id: "1", name: PATH, user_metadata: { librum_made: "1" } }), seen), PATH),
    ).toBe("no");
  });

  it("a failed info() is unknown", async () => {
    const failing = realStorage((async () =>
      new Response(JSON.stringify({ statusCode: "500", error: "x", message: "boom" }), { status: 500 })) as typeof fetch);
    expect(await readLibrumMadeMarker(failing, PATH)).toBe("unknown");
  });
});
