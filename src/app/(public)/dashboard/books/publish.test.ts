import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import JSZip from "jszip";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import { STAGING_SUPABASE_URL } from "@/lib/protected-staging";
import { PRODUCTION_SUPABASE_PROJECT_REF } from "@/lib/supabase/env-guard";

// LIBRUM 2.0 PUBLISHING-UX-1 PART B: dedicated coverage for the ONE
// authoritative publish gate (performPublish(), exercised here only
// indirectly through the two functions that actually call it --
// publishBook() and createBook()'s own "intent=publish" path -- since
// performPublish() itself is deliberately not exported; see its own
// top-of-file comment in actions.ts for why). Kept in its own file
// (separate from actions.test.ts, which is narrowly scoped to
// preview_text/file-upload regressions) since this needs its own
// mock shape: a `.select().eq().eq().single()` chain (two chained
// `.eq()` calls) that actions.test.ts's existing single-`.eq()` mock
// does not support, plus a "profiles" table and the admin-client/
// email side effect neither of which actions.test.ts's harness wires.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

// A controllable mock (rather than a bare `vi.fn()`) so individual tests
// can make a specific call throw, to prove a revalidatePath failure
// after a successful publish never prevents the success redirect.
const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => mockRevalidatePath(path) }));

// AUTH-1C: performPublish() (the shared helper both publishBook() and
// createBook()'s own intent=publish branch call into) now guards
// against an active recovery session -- see the dedicated describe
// block near the bottom of this file. Defaults to "no active recovery
// session" so every pre-existing test in this file keeps exercising
// exactly the behavior it always has.
const mockCookieStore = {
  get: vi.fn((_name: string) => undefined as { value: string } | undefined),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockGetUser = vi.fn();
const mockBookSelectResult = vi.fn();
const mockProfileSelectResult = vi.fn();
const mockBookUpdatePayload = vi.fn();
const mockBookUpdateResult = vi.fn();
const mockBookInsert = vi.fn();
const mockUploadCover = vi.fn();
const mockUploadManuscript = vi.fn();

// A minimal Supabase query-builder double: `.eq()` returns itself (so
// any number of chained `.eq()` calls works, matching both
// performPublish()'s two-`.eq()` select/update and this codebase's
// other one-`.eq()` queries), `.single()`/`.maybeSingle()` resolve via
// the given resolver, and the chain is itself thenable so `await
// builder.update(...).eq().eq()` (no trailing `.single()`, exactly how
// performPublish()'s own update call is written) also resolves via the
// same resolver -- mirrors the real supabase-js query builder's own
// "thenable" shape.
function makeChain(resolve: () => unknown) {
  const chain = {
    eq: () => chain,
    // PAID-REPRICING-1: performPublish's write is now a compare-and-set
    // (`.is()` for a null price) proved by its returned rows (`.select()`).
    is: () => chain,
    select: () => chain,
    single: () => Promise.resolve(resolve()),
    maybeSingle: () => Promise.resolve(resolve()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return chain;
}

// PAID-REPRICING-1: an error-free update result that does not say which
// rows it changed is read as "changed the one row", which is what every
// pre-existing success case in this file meant. A test that means "zero
// rows" says so with an explicit `data: []`.
function withWrittenRow(result: unknown) {
  if (result && typeof result === "object" && !("data" in result) && !(result as { error?: unknown }).error) {
    return { ...result, data: [{ id: "written-row" }] };
  }
  return result;
}

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "books") {
        return {
          select: () => makeChain(() => mockBookSelectResult()),
          update: (payload: unknown) => {
            mockBookUpdatePayload(payload);
            return makeChain(() => withWrittenRow(mockBookUpdateResult()));
          },
          // CATALOG-STORAGE-PATH-AUTH-1: createBook's insert now runs through
          // the trusted writer and proves its one new row with `.select("id")`,
          // so the double returns the inserted id.
          insert: (payload: unknown) => {
            mockBookInsert(payload);
            return {
              select: () =>
                Promise.resolve({ data: [{ id: (payload as { id: string }).id }], error: null }),
            };
          },
        };
      }
      if (table === "profiles") {
        return { select: () => makeChain(() => mockProfileSelectResult()) };
      }
      throw new Error(`unexpected table in this focused test: ${table}`);
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === "covers") return { upload: mockUploadCover };
        if (bucket === "manuscripts") return { upload: mockUploadManuscript };
        throw new Error(`unexpected bucket in this focused test: ${bucket}`);
      },
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
// CATALOG-WRITE-AUTH-1: the protected catalog writes go through
// createCatalogWriteClient(). This focused suite routes that client onto
// the same session double so its payload and filter assertions still see
// every write; WHICH client performs which write is pinned separately in
// dashboard/catalog-write-authorization.test.ts.
vi.mock("@/lib/catalog-write-client", async () => {
  const { catalogWriterReplayingOnto } = await import("@/lib/catalog-write-test-double");
  return { createCatalogWriteClient: () => catalogWriterReplayingOnto(() => mockCreateClient()) };
});

const mockCreateAdminClient = vi.fn(() => ({ __isAdminClient: true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const mockSendNewBookEmails = vi.fn<(admin: unknown, args: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
vi.mock("@/lib/email", () => ({
  sendNewBookEmails: (admin: unknown, args: unknown) => mockSendNewBookEmails(admin, args),
}));

const { createBook, publishBook } = await import("./actions");

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

async function buildFormData(overrides: Record<string, string> = {}): Promise<FormData> {
  const epubBytes = await buildValidEpubBytes();
  const formData = new FormData();
  formData.set("title", overrides.title ?? "My Book");
  formData.set("description", "A description.");
  formData.set("keywords", "");
  formData.set("isbn", "");
  formData.set("genre", "Fiction");
  formData.set("price", overrides.price ?? "0");
  if (overrides.intent) formData.set("intent", overrides.intent);
  formData.set("cover", new File([new Uint8Array(PNG_SIGNATURE)], "cover.png", { type: "image/png" }));
  formData.set(
    "manuscript",
    new File([new Uint8Array(epubBytes)], "book.epub", { type: "application/epub+zip" }),
  );
  return formData;
}

// ALL-WIRING-2: performPublish reads `price_all`, never `price_cents`.
// The default fixture is an explicitly FREE book (0), which is what
// every test that is not about the price gate wants; the missing-price
// case is `price_all: null` and has its own describe block below.
function bookRow(
  overrides: Partial<{ status: string; price_all: number | null; published_at: string | null }> = {},
) {
  return {
    data: { status: "draft", price_all: 0, published_at: null, ...overrides },
    error: null,
  };
}

// PAID-MODE-1: paid publishing requires the controlled-staging
// publishing permission (src/lib/paid-readiness.ts). Since PR-G that is
// the ONLY thing it requires. The permission is granted for every
// pre-existing test here -- otherwise they would silently become tests
// of that gate instead of their own subject -- and the gate's own
// coverage is the last describe block in THIS file.
function stubPaidPublishingAllowed() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STAGING_SUPABASE_URL);
  vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
}

function resetMocks() {
  stubPaidPublishingAllowed();
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBookSelectResult.mockReset().mockReturnValue(bookRow());
  // PR-G: `profiles` is no longer read by performPublish() at ANY price.
  // The mock is deliberately RETAINED, and deliberately returns the row
  // the removed gate would have rejected -- so every test below that
  // reaches a successful paid publish is simultaneously proof that
  // nothing read it. Do not delete this mock along with the gate.
  mockProfileSelectResult.mockReset().mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
  mockBookUpdatePayload.mockClear();
  mockBookUpdateResult.mockReset().mockReturnValue({ error: null });
  mockBookInsert.mockClear();
  mockUploadCover.mockReset().mockResolvedValue({ error: null });
  mockUploadManuscript.mockReset().mockResolvedValue({ error: null });
  mockCreateAdminClient.mockReset().mockReturnValue({ __isAdminClient: true });
  mockSendNewBookEmails.mockClear().mockResolvedValue(undefined);
  mockCookieStore.get.mockReset().mockImplementation(() => undefined);
  mockRevalidatePath.mockReset();
}

describe("publishBook: draft -> published", () => {
  beforeEach(resetMocks);

  it("publishes a free draft with no payout requirement at all", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published", published_at: expect.any(String) }),
    );
  });

  // PR-G: this replaces "publishes a paid draft when payouts are enabled"
  // and its blocked twin. The profile mock is left returning
  // stripe_payouts_enabled: false (see resetMocks), so the publication
  // succeeding IS the proof that the Stripe prerequisite is gone, and the
  // not-called assertion is the proof it was not merely ignored.
  it("publishes a paid draft with the capability allowed, reading no profile", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 999, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(expect.objectContaining({ status: "published" }));
  });

  it("publishes a paid draft when stripe_payouts_enabled is null, and when the profile row is missing entirely", async () => {
    for (const profileResult of [
      { data: { stripe_payouts_enabled: null }, error: null },
      { data: null, error: null },
    ]) {
      resetMocks();
      mockProfileSelectResult.mockReturnValue(profileResult);
      mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 999, published_at: null }));

      await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

      expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
      expect(mockProfileSelectResult).not.toHaveBeenCalled();
    }
  });

  it("sets published_at on first publish", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockBookUpdatePayload.mock.calls[0][0];
    expect(payload.published_at).toBeTypeOf("string");
    expect(Number.isNaN(new Date(payload.published_at).getTime())).toBe(false);
  });

  it("never overwrites an existing published_at on a later publish call", async () => {
    const originalTimestamp = "2024-01-01T00:00:00.000Z";
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "draft", price_all: 0, published_at: originalTimestamp }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockBookUpdatePayload.mock.calls[0][0];
    expect(payload).not.toHaveProperty("published_at");
  });

  it("republishing an already-published book is safe -- no duplicate notification, published_at untouched", async () => {
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "published", price_all: 0, published_at: "2024-01-01T00:00:00.000Z" }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload.mock.calls[0][0]).not.toHaveProperty("published_at");
  });

  it("unpublish -> republish preserves the original published_at and sends no new-book notification", async () => {
    // Simulates a book that was published once (published_at already
    // set), then unpublished (status back to draft, published_at
    // untouched by unpublishBook() -- see actions.ts), then published
    // again.
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "draft", price_all: 0, published_at: "2024-01-01T00:00:00.000Z" }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    // isFirstPublication is now derived from the pre-update published_at
    // value, not status -- published_at is already non-null here, so
    // this is correctly recognized as a republish, not a first
    // publication, and no notification is sent.
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    // published_at itself is still preserved, since it was already set.
    expect(mockBookUpdatePayload.mock.calls[0][0]).not.toHaveProperty("published_at");
  });

  it("database update failure does not redirect to success", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockBookUpdateResult.mockReturnValue({ error: { message: "db exploded" } });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockRedirect).not.toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("notification rejection after a successful write still reaches the success redirect", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockSendNewBookEmails.mockRejectedValueOnce(new Error("email service down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    // The mutation itself is unaffected by the later notification failure.
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "publishBook: sendNewBookEmails failed after a successful publish",
      expect.objectContaining({ bookId: BOOK_ID }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("createAdminClient failure after a successful write still reaches the success redirect", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error("admin client construction failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "publishBook: sendNewBookEmails failed after a successful publish",
      expect.objectContaining({ bookId: BOOK_ID }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("revalidatePath failure after a successful write still reaches the success redirect", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockRevalidatePath.mockImplementationOnce(() => {
      throw new Error("cache invalidation failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "publishBook: revalidatePath failed after a successful publish",
      expect.objectContaining({ bookId: BOOK_ID }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("sends the new-book notification only on a genuine draft -> published transition", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockSendNewBookEmails).toHaveBeenCalledOnce();
    expect(mockSendNewBookEmails).toHaveBeenCalledWith(
      { __isAdminClient: true },
      { bookId: BOOK_ID, authorId: USER_ID },
    );
  });

  it("returns a controlled result, never touching the row, for a book that doesn't exist or isn't owned by this user", async () => {
    mockBookSelectResult.mockReturnValue({ data: null, error: null });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("returns a controlled result -- never a raw DB error -- when the update itself fails", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockBookUpdateResult.mockReturnValue({ error: { message: "db exploded" } });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const target = mockRedirect.mock.calls[0][0];
    expect(target).not.toContain("db exploded");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("requires authentication before touching anything", async () => {
    mockGetUser.mockReset().mockResolvedValue({ data: { user: null } });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/login");
    expect(mockBookSelectResult).not.toHaveBeenCalled();
  });
});

describe("createBook: publish intent (PUBLISHING-UX-1 Part B)", () => {
  beforeEach(resetMocks);

  it("missing intent defaults to draft -- unchanged current-wizard behavior", async () => {
    const formData = await buildFormData();

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockBookInsert).toHaveBeenCalledOnce();
    // CATALOG-WRITE-AUTH-1: a draft by the column default -- the insert
    // never names `status`, which authenticated cannot insert.
    expect(mockBookInsert.mock.calls[0][0]).not.toHaveProperty("status");
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("intent=draft behaves identically to a missing intent", async () => {
    const formData = await buildFormData({ intent: "draft" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("intent=publish + free book publishes immediately", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The row is always inserted as a draft first (never status=
    // 'published' directly)...
    // CATALOG-WRITE-AUTH-1: a draft by the column default -- the insert
    // never names `status`, which authenticated cannot insert.
    expect(mockBookInsert.mock.calls[0][0]).not.toHaveProperty("status");
    // ...then advanced by the same authoritative helper publishBook()
    // uses.
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).toHaveBeenCalledOnce();
  });

  // PR-G: the same pair of tests as publishBook's, through the other
  // caller of the same helper. The blocked-without-payouts twin is gone
  // with the behaviour; the paid-mode denial for this caller is covered
  // in the paid-publishing describe block below.
  it("intent=publish + paid book publishes immediately with the capability allowed, reading no profile", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 999, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "999" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });

  it("intent=publish + a DB failure during the publish step: creation succeeds, book remains a draft, controlled error only", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockBookUpdateResult.mockReturnValue({ error: { message: "db exploded" } });
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookInsert).toHaveBeenCalledOnce();
    // CATALOG-WRITE-AUTH-1: a draft by the column default -- the insert
    // never names `status`, which authenticated cannot insert.
    expect(mockBookInsert.mock.calls[0][0]).not.toHaveProperty("status");
    const target = mockRedirect.mock.calls[0][0];
    expect(target).toContain("success=Saved+as+draft");
    expect(target).not.toContain("db exploded");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("notification rejection after a successful publish-on-create still reaches the success redirect", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockSendNewBookEmails.mockRejectedValueOnce(new Error("email service down"));
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "createBook: sendNewBookEmails failed after a successful publish",
      expect.objectContaining({ authorId: USER_ID }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("createAdminClient failure after a successful publish-on-create still reaches the success redirect", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    mockCreateAdminClient.mockImplementationOnce(() => {
      throw new Error("admin client construction failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("revalidatePath failure after a successful publish-on-create still reaches the success redirect", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "0" });
    // The unconditional revalidatePath("/dashboard") earlier in
    // createBook() (draft-save path, always run, out of scope for this
    // fix) must still succeed -- only the intent=publish block's own
    // revalidatePath("/") call is made to fail here.
    mockRevalidatePath.mockImplementation((path: string) => {
      if (path === "/") throw new Error("cache invalidation failed");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    // createBook() generates its own bookId via randomUUID() (a fresh
    // value each run, unlike publishBook()'s caller-supplied BOOK_ID),
    // so only the message and the field's presence are asserted here.
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "createBook: revalidatePath failed after a successful publish",
      expect.objectContaining({ bookId: expect.any(String) }),
    );
    consoleErrorSpy.mockRestore();
  });

  it("never inserts a book directly as status='published', even for intent=publish", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The ONLY insert call, and it is always a draft -- publishing (if
    // it happens at all) is always a separate, subsequent UPDATE.
    expect(mockBookInsert).toHaveBeenCalledOnce();
    expect(mockBookInsert.mock.calls[0][0]).not.toHaveProperty("status");
  });
});

// AUTH-1C: performPublish() -- the ONE shared publish helper both
// publishBook() and createBook()'s own intent=publish branch call into
// -- now guards against an active recovery session. Proven here, once,
// against BOTH call sites, rather than duplicated per call site: this
// is exactly why the guard lives in the shared helper instead of being
// copy-pasted into publishBook() and createBook() separately.
describe("performPublish: recovery-session defense-in-depth (AUTH-1C)", () => {
  beforeEach(resetMocks);

  it("publishBook: never advances status when a recovery session is active", async () => {
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toMatchObject({
      target: expect.stringContaining("/reset-password"),
    });

    expect(mockBookSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("createBook intent=publish: the draft is still inserted, but the publish step itself never advances status", async () => {
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toMatchObject({
      target: expect.stringContaining("/reset-password"),
    });

    // createBook()'s own draft-creation path is unguarded (see the
    // AUTH-1C classification report) -- only the SUBSEQUENT publish
    // step is blocked, so the book is still safely saved as a draft
    // rather than the whole create failing.
    expect(mockBookInsert).toHaveBeenCalledOnce();
    // CATALOG-WRITE-AUTH-1: a draft by the column default -- the insert
    // never names `status`, which authenticated cannot insert.
    expect(mockBookInsert.mock.calls[0][0]).not.toHaveProperty("status");
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("no active recovery session: publishBook proceeds past the guard exactly as before", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_all: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });
});

afterEach(() => vi.unstubAllEnvs());

// PAID-MODE-1 / PR-G: the paid-publishing permission, at the same
// authoritative gate every test above exercises, and since PR-G the SOLE
// gate. mockProfileSelectResult must never be called in ANY case here,
// allowed or denied: a denial that still read `profiles` would cost a
// query and could probe an author's state, and an allow that read it
// would mean the removed prerequisite had merely moved.
describe("performPublish: paid-publishing mode gate (PAID-MODE-1)", () => {
  const PAID_PRICE = 999;

  beforeEach(() => {
    resetMocks();
    // A completely configured payment provider throughout, so every
    // denial below proves the gate denied it, not a missing provider.
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("POK_ENVIRONMENT", "staging");
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: PAID_PRICE }));
    // Left at the value the REMOVED gate would have rejected, on purpose
    // -- see resetMocks. Nothing in this block may read it.
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["wrongly cased", "CONTROLLED_STAGING_PUBLISHING_TEST"],
    ["whitespace padded", " controlled_staging_publishing_test"],
    ["the checkout mode's value", "controlled_staging_checkout_test"],
    ["the superseded shared value", "controlled_staging_test"],
    ["production", "production"],
  ])("a %s publishing mode denies a paid book WITHOUT reading profiles", async (_label, value) => {
    vi.stubEnv("PAID_PUBLISHING_MODE", value as string);

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it.each([
    ["Vercel Production", "VERCEL_ENV", "production"],
    ["another branch's Preview", "VERCEL_GIT_COMMIT_REF", "feat/anything"],
    ["the production Supabase project", "NEXT_PUBLIC_SUPABASE_URL", `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`],
  ])("denies on %s even with the mode set correctly", async (_label, key, value) => {
    vi.stubEnv(key, value);

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
  });

  it("the denial reveals no configuration, environment or payout state", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    for (const leak of ["PAID_PUBLISHING_MODE", "controlled_staging", "preview", "staging", "payout", "stripe"]) {
      expect(redirectedUrl).not.toContain(leak);
    }
  });

  // PR-G, the canonical proof, and the assertion the old tests could not
  // make: with the capability ALLOWED, a paid book publishes and the
  // `profiles` row is never read. This replaced two tests -- "the
  // existing payout gate still blocks a paid book" (that behaviour is
  // removed) and its payouts-enabled twin (the flag no longer
  // participates). It is what stops the removal from being reintroduced
  // under another name: any new per-author publishing prerequisite read
  // from `profiles` fails here.
  it("with the capability allowed, a paid book publishes and no profile is ever read", async () => {
    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });

  // Removing the prerequisite did not bypass the capability: denial is
  // still total, and the book row is never touched.
  it("with the capability denied, a paid book stays a draft however the payout flag reads", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: true }, error: null });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  // Free publishing is never gated, under any configuration -- the
  // price fork decides, and it is read from the book's own row.
  it("a free book publishes with the mode variable unset, and reads no profile", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: 0 }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });

  // The other caller of the same helper: createBook(intent=publish)
  // inherits the gate, and says so honestly rather than falling into
  // its generic "please try again" message.
  it("createBook(intent=publish) saves the draft and reports the paid-mode denial", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: PAID_PRICE }));

    await expect(
      createBook(await buildFormData({ price: "999", intent: "publish" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?success=Saved+as+draft&error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockBookInsert).toHaveBeenCalled();
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
  });
});

// ============================================================
// ALL-WIRING-2: publishing is now a THREE-way decision on the book's
// own `price_all`, read server-side.
//
//   null -> refused, with its own distinct blocker. Not "free", not
//           "paid", and specifically NOT an unpublish.
//   0    -> free publication, no paid-mode permission involved.
//   > 0  -> paid publication, requiring canPublishPaidTitle().
//
// The two refusals must stay DISTINGUISHABLE. Collapsing the missing
// price into the paid-mode denial would tell an author that paid
// publishing is closed when their actual problem is that they never
// entered a price -- an error they can fix in ten seconds, hidden
// behind one they cannot fix at all.
// ============================================================
describe("performPublish: the missing-ALL-price blocker (ALL-WIRING-2)", () => {
  beforeEach(resetMocks);

  it("a null price refuses to publish and never touches the row", async () => {
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "draft", price_all: null, published_at: null }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("its message is its OWN, distinct from the paid-mode denial", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: null }));
    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);
    const missingTarget = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);

    resetMocks();
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: 999 }));
    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);
    const paidTarget = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);

    expect(missingTarget).not.toBe(paidTarget);
    expect(missingTarget).toContain("price in lek");
    expect(paidTarget).not.toContain("price in lek");
    // It points the author at their own edit page, where the fix is.
    expect(missingTarget.startsWith(`/dashboard/books/${BOOK_ID}/edit?error=`)).toBe(true);
  });

  it("the blocker is reached even when paid publishing IS permitted", async () => {
    // Ordering: the price classification comes first, so an author with
    // the capability still gets the accurate blocker rather than a
    // successful publish of a priceless book.
    stubPaidPublishingAllowed();
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string)).toContain(
      "price in lek",
    );
  });

  it("an ALREADY-PUBLISHED book with a null price is never moved back to draft", async () => {
    // The refusal is a refusal to publish, not an unpublish. A legacy
    // row that is live today stays live; only its discovery surfaces
    // change.
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "published", price_all: null, published_at: "2026-01-01T00:00:00.000Z" }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    // Nothing anywhere in the action writes a status at all on this path.
    const wroteStatus = mockBookUpdatePayload.mock.calls.some(
      (call) => (call[0] as Record<string, unknown>).status !== undefined,
    );
    expect(wroteStatus).toBe(false);
  });

  it("an out-of-domain price is refused the same way, never treated as paid", async () => {
    // 50 cannot exist in the column, but if it did, the fail-safe
    // direction is "no price" rather than "a 50-lek sale".
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: 50 }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string)).toContain(
      "price in lek",
    );
  });

  it("createBook(intent=publish) with a null price saves the draft and reports the blocker", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ price_all: null }));

    await expect(
      createBook(await buildFormData({ intent: "publish", price: "0" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    // The row was still created -- an author never loses their upload.
    expect(mockBookInsert).toHaveBeenCalledTimes(1);
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string)).toContain(
      "price in lek",
    );
  });
});

describe("performPublish: price_all is the SOLE free/paid authority (ALL-WIRING-2)", () => {
  beforeEach(resetMocks);

  // The legacy row shape this whole patch exists for: price_all 199
  // beside a price_cents of 0. Under the OLD gate it was free and
  // published with no permission at all; it is paid now.
  it("price_all 199 is PAID and requires the capability, whatever price_cents says", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    // The select deliberately also carries the misleading legacy value.
    mockBookSelectResult.mockReturnValue({
      data: { status: "draft", price_all: 199, price_cents: 0, published_at: null },
      error: null,
    });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?error=Paid+publishing+isn%27t+available+right+now",
    );
  });

  it("price_all 0 is FREE and publishes with the mode unset, whatever price_cents says", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBookSelectResult.mockReturnValue({
      data: { status: "draft", price_all: 0, price_cents: 9900, published_at: null },
      error: null,
    });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });

  it("the row the action reads does not include price_cents at all", async () => {
    // Belt and braces on the two tests above: the select list itself is
    // the guarantee that a legacy value cannot influence the decision,
    // because it never arrives.
    const source = readFileSync(
      fileURLToPath(new URL("./actions.ts", import.meta.url)),
      "utf8",
    );
    const selectList = source.match(/\.select\("status, [^"]*"\)/)?.[0];
    expect(selectList).toBe('.select("status, price_all, published_at")');
  });
});
