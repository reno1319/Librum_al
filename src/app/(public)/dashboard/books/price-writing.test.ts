import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

// ALL-WIRING-2: the author-facing WRITE side of the ALL cutover.
//
// publish.test.ts in this directory covers performPublish (the read
// side of the same column). This file covers the only two actions that
// WRITE a catalog price -- createBook and updateBook -- and it exists
// because the three properties below cannot be seen from either the
// parser's own unit tests or the publish gate's:
//
//   1. a rejected price performs NO insert, NO update and NO storage
//      write. parseCatalogPriceAll being correct proves nothing about
//      WHERE its result is checked; only driving the real action and
//      asserting that the Supabase double was never called does.
//   2. the payload carries `price_all` and does NOT carry
//      `price_cents`. An extra legacy key would be invisible to every
//      type check (the insert is untyped at the client boundary) and
//      would quietly re-establish the dual-writing this patch exists to
//      end.
//   3. the maintenance gate runs BEFORE the Supabase client is even
//      created, for both actions.
//
// The Supabase double therefore records every call it receives, and the
// "no write" assertions are made against the double rather than against
// a redirect target -- a redirect proves the user saw an error, not
// that the database was left alone.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => mockRevalidatePath(path) }));

const mockCookieStore = {
  get: vi.fn((_name: string) => undefined as { value: string } | undefined),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockGetUser = vi.fn();
const mockBookInsert = vi.fn();
const mockBookUpdatePayload = vi.fn();
const mockBookSelectResult = vi.fn();
const mockUploadCover = vi.fn();
const mockUploadManuscript = vi.fn();
const mockStorageRemove = vi.fn();
// The single witness for "the database was never reached": every
// createClient() call increments it, so a test can assert zero.
const mockCreateClientCalls = vi.fn();

function makeChain(resolve: () => unknown) {
  const chain = {
    eq: () => chain,
    // PAID-REPRICING-1: updateBook's write is guarded (`.is()` for a null
    // price) and proved by its returned rows (`.select()`).
    is: () => chain,
    select: () => chain,
    single: () => Promise.resolve(resolve()),
    maybeSingle: () => Promise.resolve(resolve()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return chain;
}

const mockCreateClient = vi.fn(() => {
  mockCreateClientCalls();
  return Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "books") {
        return {
          select: () => makeChain(() => mockBookSelectResult()),
          insert: (payload: unknown) => {
            mockBookInsert(payload);
            return Promise.resolve({ error: null });
          },
          update: (payload: unknown) => {
            mockBookUpdatePayload(payload);
            return makeChain(() => ({ data: [{ id: BOOK_ID }], error: null }));
          },
        };
      }
      throw new Error(`unexpected table in this focused test: ${table}`);
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === "covers") return { upload: mockUploadCover, remove: mockStorageRemove };
        if (bucket === "manuscripts")
          return { upload: mockUploadManuscript, remove: mockStorageRemove };
        throw new Error(`unexpected bucket in this focused test: ${bucket}`);
      },
    },
  });
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const mockCreateAdminClient = vi.fn(() => ({ __isAdminClient: true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const mockSendNewBookEmails = vi.fn<(admin: unknown, args: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock("@/lib/email", () => ({
  sendNewBookEmails: (admin: unknown, args: unknown) => mockSendNewBookEmails(admin, args),
}));

// Imported AFTER the vi.mock calls above: maintenance-response itself
// imports next/navigation, so a static import of it at the top of this
// file loads the real redirect before the mock is installed.
const { MAINTENANCE_MESSAGE } = await import("@/lib/maintenance-response");
const { createBook, updateBook } = await import("./actions");

const USER_ID = "author-1";
const BOOK_ID = "book-1";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

async function buildValidEpubBytes(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest></manifest><spine></spine></package>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

async function buildFormData(price: string): Promise<FormData> {
  const epubBytes = await buildValidEpubBytes();
  const formData = new FormData();
  formData.set("title", "My Book");
  formData.set("description", "A description.");
  formData.set("keywords", "");
  formData.set("isbn", "");
  formData.set("genre", "Fiction");
  formData.set("price", price);
  formData.set(
    "cover",
    new File([new Uint8Array(PNG_SIGNATURE)], "cover.png", { type: "image/png" }),
  );
  formData.set(
    "manuscript",
    new File([new Uint8Array(epubBytes)], "book.epub", { type: "application/epub+zip" }),
  );
  return formData;
}

function resetMocks() {
  vi.unstubAllEnvs();
  mockRedirect.mockClear();
  mockCreateClient.mockClear();
  mockCreateClientCalls.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBookSelectResult.mockReset().mockReturnValue({
    // PAID-REPRICING-1: a draft, so a paid price may be saved without
    // paid-publishing permission; the published cases set their own row.
    data: {
      cover_path: "c.png", file_path: "f.epub", author_id: USER_ID, language: "sq",
      status: "draft", price_all: null,
    },
    error: null,
  });
  mockBookInsert.mockClear();
  mockBookUpdatePayload.mockClear();
  mockUploadCover.mockReset().mockResolvedValue({ error: null });
  mockUploadManuscript.mockReset().mockResolvedValue({ error: null });
  mockStorageRemove.mockReset().mockResolvedValue({ error: null });
  mockCreateAdminClient.mockReset().mockReturnValue({ __isAdminClient: true });
  mockSendNewBookEmails.mockClear().mockResolvedValue(undefined);
  mockCookieStore.get.mockReset().mockImplementation(() => undefined);
  mockRevalidatePath.mockReset();
}

/** Every Supabase-side effect either action can produce. */
function noWriteHappened() {
  expect(mockBookInsert).not.toHaveBeenCalled();
  expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  expect(mockUploadCover).not.toHaveBeenCalled();
  expect(mockUploadManuscript).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

// ============================================================
describe("createBook: the accepted price is written to price_all and nothing else", () => {
  beforeEach(resetMocks);

  it("writes price_all and omits price_cents entirely", async () => {
    await expect(createBook(await buildFormData("999"))).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookInsert).toHaveBeenCalledTimes(1);
    const payload = mockBookInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.price_all).toBe(999);
    // Not "price_cents is 0" -- the KEY must be absent, so a later
    // reader of this row cannot find a legacy value to prefer.
    expect(payload).not.toHaveProperty("price_cents");
    expect(Object.keys(payload).filter((k) => k.includes("price"))).toEqual(["price_all"]);
  });

  it("writes 0 for an explicitly free book -- never null, never omitted", async () => {
    await expect(createBook(await buildFormData("0"))).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockBookInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.price_all).toBe(0);
    expect(payload).not.toHaveProperty("price_cents");
  });

  it("normalizes the Albanian comma form and the dot form to the same integer", async () => {
    for (const [input, expected] of [
      ["99", 99],
      ["99,00", 99],
      ["99.00", 99],
      ["00099", 99],
      ["  1500  ", 1500],
      ["100000", 100000],
    ] as Array<[string, number]>) {
      resetMocks();
      await expect(createBook(await buildFormData(input))).rejects.toBeInstanceOf(RedirectSignal);
      const payload = mockBookInsert.mock.calls[0][0] as Record<string, unknown>;
      expect(payload.price_all).toBe(expected);
      expect(payload).not.toHaveProperty("price_cents");
    }
  });

  // The defect the old `Math.round(Number(raw) * 100)` would have
  // produced: 99 lek written as 9900. The catalog column is WHOLE lek.
  it("never scales the value by 100 on its way into the column", async () => {
    await expect(createBook(await buildFormData("99"))).rejects.toBeInstanceOf(RedirectSignal);
    const payload = mockBookInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.price_all).toBe(99);
    expect(payload.price_all).not.toBe(9900);
  });
});

describe("updateBook: the accepted price is written to price_all and nothing else", () => {
  beforeEach(resetMocks);

  it("writes price_all and omits price_cents entirely", async () => {
    await expect(updateBook(BOOK_ID, await buildFormData("250"))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockBookUpdatePayload).toHaveBeenCalledTimes(1);
    const payload = mockBookUpdatePayload.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.price_all).toBe(250);
    expect(payload).not.toHaveProperty("price_cents");
    expect(Object.keys(payload).filter((k) => k.includes("price"))).toEqual(["price_all"]);
  });

  it("saving 0 makes a paid book free, and saving a price brings an unpriced one back", async () => {
    mockBookSelectResult.mockReturnValue({
      data: {
        cover_path: "c.png", file_path: "f.epub", author_id: USER_ID, language: "sq",
        status: "published", price_all: 1200,
      },
      error: null,
    });
    await expect(updateBook(BOOK_ID, await buildFormData("0"))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(
      (mockBookUpdatePayload.mock.calls[0][0] as Record<string, unknown>).price_all,
    ).toBe(0);

    resetMocks();
    // The single act that returns a legacy null-priced row to listings
    // and to search_books: the author saving a valid ALL price.
    //
    // PAID-REPRICING-1: for a PUBLISHED unpriced row, a PAID price is a
    // paid publication, so it needs paid-publishing permission (granted
    // here; the refusal without it is covered in paid-repricing-guards
    // tests). A free price needs none.
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://erhzpapqwyfjotliqdjo.supabase.co");
    vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
    mockBookSelectResult.mockReturnValue({
      data: {
        cover_path: "c.png", file_path: "f.epub", author_id: USER_ID, language: "sq",
        status: "published", price_all: null,
      },
      error: null,
    });
    await expect(updateBook(BOOK_ID, await buildFormData("1200"))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(
      (mockBookUpdatePayload.mock.calls[0][0] as Record<string, unknown>).price_all,
    ).toBe(1200);
  });

  it("never writes null: the update always carries a resolved integer", async () => {
    await expect(updateBook(BOOK_ID, await buildFormData("99"))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    const payload = mockBookUpdatePayload.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.price_all).toBe(99);
    expect(payload.price_all).not.toBeNull();
  });
});

// ============================================================
// A rejected price costs NOTHING. Driven through the real action, so
// the assertion is about the database double, not about a message.
// ============================================================
describe("an invalid author price performs no database write at all", () => {
  const rejected = [
    ["empty", ""],
    ["whitespace only", "   "],
    ["one lek -- inside the unsellable 1..98 band", "1"],
    ["ninety-eight lek -- the top of that band", "98"],
    ["a fractional amount", "99,50"],
    ["a fractional amount, dot form", "99.50"],
    ["an ambiguous grouped form", "1.500"],
    ["a mixed separator form", "1,500.00"],
    ["a negative amount", "-99"],
    ["negative zero", "-0"],
    ["a signed amount", "+99"],
    ["exponent notation", "1e3"],
    ["a value above the ceiling", "100001"],
    ["an absurdly long payload", "9".repeat(64)],
    ["not a number at all", "free"],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
  ] as Array<[string, string]>;

  beforeEach(resetMocks);

  it.each(rejected)("createBook: %s inserts nothing and uploads nothing", async (_label, price) => {
    await expect(createBook(await buildFormData(price))).rejects.toBeInstanceOf(RedirectSignal);
    noWriteHappened();
    // ...and the reader is told, rather than silently getting a draft.
    const target = mockRedirect.mock.calls.at(-1)?.[0] as string;
    expect(target.startsWith("/dashboard/books/new?error=")).toBe(true);
  });

  it.each(rejected)("updateBook: %s updates nothing and uploads nothing", async (_label, price) => {
    await expect(updateBook(BOOK_ID, await buildFormData(price))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    noWriteHappened();
    const target = mockRedirect.mock.calls.at(-1)?.[0] as string;
    expect(target.startsWith(`/dashboard/books/${BOOK_ID}/edit?error=`)).toBe(true);
  });

  it("the error message names the accepted domain and echoes no internal detail", async () => {
    await expect(createBook(await buildFormData("42"))).rejects.toBeInstanceOf(RedirectSignal);
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    expect(target).toMatch(/99/);
    expect(target).toMatch(/100[.,]?000/);
    expect(target).not.toMatch(/price_all|price_cents|supabase|postgres/i);
    expect(target).not.toContain("$");
  });

  // A missing field is not the same as an invalid one, and neither may
  // reach the database.
  it("a price field the form never submitted is rejected, not defaulted to free", async () => {
    const formData = await buildFormData("0");
    formData.delete("price");
    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);
    noWriteHappened();
  });
});

// ============================================================
// Maintenance mode is ABOVE the Supabase client, not merely above the
// write. Asserted by counting createClient() calls: a gate that ran
// after the client was constructed would still pass a "no insert"
// check while having already opened a session.
// ============================================================
describe("maintenance mode stops every price-writing action before any Supabase call", () => {
  beforeEach(resetMocks);

  it("createBook: redirects with the maintenance message, never creating a client", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");

    await expect(createBook(await buildFormData("999"))).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockCreateClientCalls).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    noWriteHappened();
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    expect(target).toContain(MAINTENANCE_MESSAGE);
  });

  it("updateBook: redirects with the maintenance message, never creating a client", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");

    await expect(updateBook(BOOK_ID, await buildFormData("999"))).rejects.toBeInstanceOf(
      RedirectSignal,
    );

    expect(mockCreateClientCalls).not.toHaveBeenCalled();
    expect(mockGetUser).not.toHaveBeenCalled();
    noWriteHappened();
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    expect(target).toContain(MAINTENANCE_MESSAGE);
  });

  it("the gate beats an INVALID price too -- the maintenance message, not the price error", async () => {
    // Ordering matters: if the price check ran first, a reader in a
    // maintenance window would be told to fix their price rather than
    // that the site is closed for writes.
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    await expect(createBook(await buildFormData("42"))).rejects.toBeInstanceOf(RedirectSignal);
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    expect(target).toContain(MAINTENANCE_MESSAGE);
    expect(mockCreateClientCalls).not.toHaveBeenCalled();
  });

  it("with the gate off, the same call reaches the database -- proving the gate is what stopped it", async () => {
    await expect(createBook(await buildFormData("999"))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockCreateClientCalls).toHaveBeenCalled();
    expect(mockBookInsert).toHaveBeenCalledTimes(1);
  });
});
