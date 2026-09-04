import { describe, expect, it, vi, beforeEach } from "vitest";
import JSZip from "jszip";

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
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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
    single: () => Promise.resolve(resolve()),
    maybeSingle: () => Promise.resolve(resolve()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return chain;
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
            return makeChain(() => mockBookUpdateResult());
          },
          insert: (payload: unknown) => {
            mockBookInsert(payload);
            return Promise.resolve({ error: null });
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

function bookRow(overrides: Partial<{ status: string; price_cents: number; published_at: string | null }> = {}) {
  return {
    data: { status: "draft", price_cents: 0, published_at: null, ...overrides },
    error: null,
  };
}

function resetMocks() {
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBookSelectResult.mockReset().mockReturnValue(bookRow());
  mockProfileSelectResult.mockReset().mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
  mockBookUpdatePayload.mockClear();
  mockBookUpdateResult.mockReset().mockReturnValue({ error: null });
  mockBookInsert.mockClear();
  mockUploadCover.mockReset().mockResolvedValue({ error: null });
  mockUploadManuscript.mockReset().mockResolvedValue({ error: null });
  mockCreateAdminClient.mockClear();
  mockSendNewBookEmails.mockClear().mockResolvedValue(undefined);
}

describe("publishBook: draft -> published", () => {
  beforeEach(resetMocks);

  it("publishes a free draft with no payout requirement at all", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published", published_at: expect.any(String) }),
    );
  });

  it("publishes a paid draft when payouts are enabled", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 999, published_at: null }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: true }, error: null });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(expect.objectContaining({ status: "published" }));
  });

  it("blocks a paid draft when payouts are not enabled -- book stays unpublished", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 999, published_at: null }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?error=Connect+your+payout+account+before+publishing",
    );
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("sets published_at on first publish", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockBookUpdatePayload.mock.calls[0][0];
    expect(payload.published_at).toBeTypeOf("string");
    expect(Number.isNaN(new Date(payload.published_at).getTime())).toBe(false);
  });

  it("never overwrites an existing published_at on a later publish call", async () => {
    const originalTimestamp = "2024-01-01T00:00:00.000Z";
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "draft", price_cents: 0, published_at: originalTimestamp }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockBookUpdatePayload.mock.calls[0][0];
    expect(payload).not.toHaveProperty("published_at");
  });

  it("republishing an already-published book is safe -- no duplicate notification, published_at untouched", async () => {
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "published", price_cents: 0, published_at: "2024-01-01T00:00:00.000Z" }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload.mock.calls[0][0]).not.toHaveProperty("published_at");
  });

  it("unpublish -> republish preserves the original published_at and does not re-notify", async () => {
    // Simulates a book that was published once (published_at already
    // set), then unpublished (status back to draft, published_at
    // untouched by unpublishBook() -- see actions.ts), then published
    // again.
    mockBookSelectResult.mockReturnValue(
      bookRow({ status: "draft", price_cents: 0, published_at: "2024-01-01T00:00:00.000Z" }),
    );

    await expect(publishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    // wasNewlyPublished is true here (status was "draft" at read time)
    // -- current documented semantics (Part A/B brief): an unpublish/
    // republish cycle DOES currently re-trigger the "new book" author
    // notification, exactly as it did before this refactor (the
    // pre-extraction code's own gate was `if (book.status === "draft")`,
    // unconditionally true after any unpublish). This is reported
    // explicitly, not silently changed.
    expect(mockSendNewBookEmails).toHaveBeenCalledOnce();
    // published_at itself is still preserved, since it was already set.
    expect(mockBookUpdatePayload.mock.calls[0][0]).not.toHaveProperty("published_at");
  });

  it("sends the new-book notification only on a genuine draft -> published transition", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));

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
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));
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
    expect(mockBookInsert.mock.calls[0][0]).toMatchObject({ status: "draft" });
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("intent=draft behaves identically to a missing intent", async () => {
    const formData = await buildFormData({ intent: "draft" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("intent=publish + free book publishes immediately", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The row is always inserted as a draft first (never status=
    // 'published' directly)...
    expect(mockBookInsert.mock.calls[0][0]).toMatchObject({ status: "draft" });
    // ...then advanced by the same authoritative helper publishBook()
    // uses.
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockSendNewBookEmails).toHaveBeenCalledOnce();
  });

  it("intent=publish + paid book with payouts enabled publishes immediately", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 999, published_at: null }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: true }, error: null });
    const formData = await buildFormData({ intent: "publish", price: "9.99" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?success=Your+book+is+now+live");
    expect(mockBookUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });

  it("intent=publish + paid book WITHOUT payouts: creation succeeds, publish is blocked, book remains a draft", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 999, published_at: null }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
    const formData = await buildFormData({ intent: "publish", price: "9.99" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The critical invariant: the book row was inserted (as a draft)
    // regardless of the publish outcome.
    expect(mockBookInsert).toHaveBeenCalledOnce();
    expect(mockBookInsert.mock.calls[0][0]).toMatchObject({ status: "draft" });
    // Publish was attempted and blocked -- never advanced to published.
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?success=Saved+as+draft&error=Connect+your+payout+account+before+publishing",
    );
  });

  it("intent=publish + a DB failure during the publish step: creation succeeds, book remains a draft, controlled error only", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));
    mockBookUpdateResult.mockReturnValue({ error: { message: "db exploded" } });
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookInsert).toHaveBeenCalledOnce();
    expect(mockBookInsert.mock.calls[0][0]).toMatchObject({ status: "draft" });
    const target = mockRedirect.mock.calls[0][0];
    expect(target).toContain("success=Saved+as+draft");
    expect(target).not.toContain("db exploded");
    expect(mockSendNewBookEmails).not.toHaveBeenCalled();
  });

  it("never inserts a book directly as status='published', even for intent=publish", async () => {
    mockBookSelectResult.mockReturnValue(bookRow({ status: "draft", price_cents: 0, published_at: null }));
    const formData = await buildFormData({ intent: "publish", price: "0" });

    await expect(createBook(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The ONLY insert call, and it is always a draft -- publishing (if
    // it happens at all) is always a separate, subsequent UPDATE.
    expect(mockBookInsert).toHaveBeenCalledOnce();
    expect(mockBookInsert.mock.calls[0][0].status).toBe("draft");
  });
});
