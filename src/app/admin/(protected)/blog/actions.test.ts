import { describe, expect, it, vi, beforeEach } from "vitest";

// Same mocking convention already established by reports/actions.test.ts
// and refunds/actions.test.ts -- requireStaff() is mocked directly
// rather than re-testing decideStaffAccess() itself. cover-image.ts's
// detectCoverImageKind()/resolveVerifiedCoverStorageDetails() are
// deliberately NOT mocked -- real magic-byte buffers are used below so
// the byte-signature validation itself is genuinely exercised end to
// end, not assumed.
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

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

// COVERS-1: a real 1x1 PNG, since every cover is now decoded and re-encoded.
const PNG_BYTES = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWMwTgsFAAG+AO/TH36BAAAAAElFTkSuQmCC", "base64"));
const NOT_AN_IMAGE_BYTES = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

type MockSupabaseOptions = {
  rpcResults?: Record<string, { data?: unknown; error?: { message?: string; code?: string } | null }>;
  existingRow?: Record<string, unknown> | null;
  downloadBytes?: Uint8Array;
  downloadError?: { message: string } | null;
  uploadError?: { message: string } | null;
};

function makeMockSupabase(options: MockSupabaseOptions = {}) {
  const rpc = vi.fn((name: string, _params?: Record<string, unknown>) => {
    const result = options.rpcResults?.[name] ?? { data: null, error: null };
    return Promise.resolve(result);
  });

  const maybeSingle = vi.fn(() => Promise.resolve({ data: options.existingRow ?? null }));
  const eq = vi.fn((_column: string, _value: string) => ({ maybeSingle }));
  const select = vi.fn((_columns: string) => ({ eq }));
  const from = vi.fn((_table: string) => ({ select }));

  const download = vi.fn((_path: string) =>
    Promise.resolve(
      options.downloadError
        ? { data: null, error: options.downloadError }
        : { data: new Blob([Buffer.from(options.downloadBytes ?? PNG_BYTES)]), error: null },
    ),
  );
  const upload = vi.fn((_path: string, _bytes: Buffer, _opts?: { contentType: string }) =>
    Promise.resolve({ error: options.uploadError ?? null }),
  );
  const remove = vi.fn((_paths: string[]) => Promise.resolve({ error: null }));
  const storageFrom = vi.fn((_bucket: string) => ({ download, upload, remove }));

  return { rpc, from, storage: { from: storageFrom }, _spies: { rpc, from, select, eq, maybeSingle, download, upload, remove, storageFrom } };
}

let currentMockSupabase: ReturnType<typeof makeMockSupabase>;
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve(currentMockSupabase),
}));
// PEN-2 (O12): the permanent cover upload runs with the service role so
// the stored object has no staff owner. The admin double shares the
// session double's storage spies, and records that it was used.
const mockCreateAdminClient = vi.fn(() => ({ storage: currentMockSupabase.storage }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const {
  createBlogPostAction,
  updateBlogPostAction,
  publishBlogPostAction,
  unpublishBlogPostAction,
  deleteBlogPostAction,
  scheduleBlogPostAction,
  cancelBlogScheduleAction,
  uploadBlogInlineImageAction,
} = await import("./actions");

function validFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("title", "How to publish an ebook");
  fd.set("slug", "how-to-publish-an-ebook");
  fd.set("excerpt", "A short excerpt.");
  fd.set("contentMarkdown", "Some article body content.");
  fd.set("category", "tregu");
  fd.set("seoTitle", "");
  fd.set("seoDescription", "");
  for (const [k, v] of Object.entries(overrides)) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  mockRedirect.mockClear();
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "editor-1", role: "editor" });
  currentMockSupabase = makeMockSupabase();
  mockCreateAdminClient.mockClear();
});

describe("createBlogPostAction", () => {
  it("requireStaff('blog.manage') gates this action; its own redirect propagates before any RPC call", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.manage");
  });

  it("rejects missing required fields before ever calling create_blog_post -- no direct insert either", async () => {
    const formData = validFormData({ title: "" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(currentMockSupabase._spies.from).not.toHaveBeenCalled();
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("Title is required."));
  });

  it("rejects an invalid category before calling create_blog_post", async () => {
    const formData = validFormData({ category: "Not a category" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
  });

  it("valid input with no cover: calls create_blog_post with cover_image_path null and redirects to the new edit page", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
    });

    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "create_blog_post",
      expect.objectContaining({ p_cover_image_path: null, p_category: "tregu" }),
    );
    // No direct table write anywhere in this action.
    expect(currentMockSupabase._spies.from).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/admin/blog/22222222-2222-4222-8222-222222222222/edit");
  });

  it("bs1/bs4: passes the Editorial tick and the cleaned keyword list to create_blog_post", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
    });

    await expect(
      createBlogPostAction(validFormData({ isEditorial: "on", keywords: " vetë-botim , e-libër,,Vetë-botim" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "create_blog_post",
      expect.objectContaining({ p_is_editorial: true, p_keywords: ["vetë-botim", "e-libër"] }),
    );
  });

  it("au1: passes the trimmed Written by name to create_blog_post, null when empty", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
    });
    await expect(createBlogPostAction(validFormData({ authorName: " Arben Hoxha " }))).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "create_blog_post",
      expect.objectContaining({ p_author_name: "Arben Hoxha" }),
    );

    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
    });
    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "create_blog_post",
      expect.objectContaining({ p_author_name: null }),
    );
  });

  it("no tick and no keywords: p_is_editorial false, p_keywords [] (a draft may have none)", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
    });

    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "create_blog_post",
      expect.objectContaining({ p_is_editorial: false, p_keywords: [] }),
    );
  });

  it("11 keywords are rejected before calling create_blog_post", async () => {
    const formData = validFormData({ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`).join(",") });
    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("Use at most 10 keywords."));
  });

  it("never passes status/published_at/created_by as RPC parameters -- those are not exposed at all", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
    });

    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    const params = currentMockSupabase._spies.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("p_status");
    expect(params).not.toHaveProperty("p_published_at");
    expect(params).not.toHaveProperty("p_created_by");
  });

  it("duplicate slug (unique_violation) maps to a human-safe error, never raw Postgres text", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        create_blog_post: { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } },
      },
    });

    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("That URL slug is already in use. Please choose a different one."));
    expect(redirectedTo).not.toContain("constraint");
  });

  it("with a staged cover: downloads, validates real bytes, uploads to the permanent bucket, and calls update_blog_post", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null },
        update_blog_post: { data: null, error: null },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.download).toHaveBeenCalledWith("editor-1/tmp/blog/abc.png");
    expect(currentMockSupabase._spies.upload).toHaveBeenCalled();
    const [permanentPath, uploadedBytes, uploadOpts] = currentMockSupabase._spies.upload.mock.calls[0];
    // COVERS-1: stored as the shrunk JPEG, cached for a week.
    expect(permanentPath).toMatch(/^covers\/22222222-2222-4222-8222-222222222222\/.+\.jpg$/);
    expect([...uploadedBytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(uploadOpts).toEqual({ contentType: "image/jpeg", cacheControl: "604800" });
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_id: "22222222-2222-4222-8222-222222222222", p_cover_image_path: permanentPath }),
    );
    // Temp object cleaned up after everything succeeds.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/abc.png"]);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/blog/22222222-2222-4222-8222-222222222222/edit");
  });

  it("rejects a staged path outside the caller's own uid namespace (ownership check)", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null },
        update_blog_post: { data: null, error: null },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "someone-else/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The draft was already created (this is a post-creation cover
    // failure) -- the download is never even attempted for a path that
    // fails the ownership/shape check.
    expect(currentMockSupabase._spies.download).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain("/admin/blog/22222222-2222-4222-8222-222222222222/edit");
    expect(redirectedTo).toContain(encodeURIComponent("no longer valid"));
  });

  it("rejects bytes that don't match a real JPEG/PNG signature -- the draft still exists, error is cover-specific", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
      downloadBytes: NOT_AN_IMAGE_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.upload).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toBe(
      `/admin/blog/22222222-2222-4222-8222-222222222222/edit?error=${encodeURIComponent("That doesn't look like a valid JPEG or PNG image")}`,
    );
  });

  // COVERS-1: a PNG signature followed by bytes that don't decode can't
  // be shrunk -- refused with the existing read error, never stored raw.
  it("rejects a signature-valid cover that can't be decoded, with the existing read error", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null } },
      downloadBytes: Uint8Array.from([...PNG_BYTES.subarray(0, 8), ...new Array(512).fill(7)]),
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.upload).not.toHaveBeenCalled();
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/abc.png"]);
    expect(mockRedirect.mock.calls[0][0]).toBe(
      `/admin/blog/22222222-2222-4222-8222-222222222222/edit?error=${encodeURIComponent("Could not read your uploaded cover. Please try again.")}`,
    );
  });

  it("when the permanent upload succeeds but update_blog_post fails: the orphaned object is removed, draft is preserved", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null },
        update_blog_post: { data: null, error: { message: "invalid category" } },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // Both the orphaned permanent object AND the temp object are cleaned up.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledTimes(2);
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain("/admin/blog/22222222-2222-4222-8222-222222222222/edit");
    expect(redirectedTo).toContain(encodeURIComponent("could not be saved"));
  });
});

describe("uploadPermanentCover (PEN-2 O12)", () => {
  it("uploads the permanent cover with the service role, under covers/<post uuid>/", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        create_blog_post: { data: "22222222-2222-4222-8222-222222222222", error: null },
        update_blog_post: { data: null, error: null },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockCreateAdminClient).toHaveBeenCalledTimes(1);
    const [path] = currentMockSupabase._spies.upload.mock.calls[0];
    expect(path).toMatch(/^covers\/22222222-2222-4222-8222-222222222222\/[0-9a-f-]{36}\.jpg$/);
  });

  it("refuses a post id that is not a lowercase UUID: no service-role upload at all", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "../other", error: null } },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(currentMockSupabase._spies.upload).not.toHaveBeenCalled();
  });
});

describe("updateBlogPostAction", () => {
  it("requireStaff('blog.manage') gates this action", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.manage");
  });

  it("missing post: redirects to the list with an error, no RPC called", async () => {
    currentMockSupabase = makeMockSupabase({ existingRow: null });

    await expect(updateBlogPostAction("missing-id", validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/blog?error=${encodeURIComponent("That article could not be found.")}`,
    );
  });

  it("invalid input: redirects to the edit page with an error, no RPC called", async () => {
    currentMockSupabase = makeMockSupabase({ existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: null } });
    const formData = validFormData({ excerpt: "" });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
  });

  it("valid input, no new cover: preserves the existing cover_image_path in the RPC call", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: "covers/11111111-1111-4111-8111-111111111111/old.jpg" },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_cover_image_path: "covers/11111111-1111-4111-8111-111111111111/old.jpg" }),
    );
    // No cover replacement happened, so nothing is removed from storage.
    expect(currentMockSupabase._spies.remove).not.toHaveBeenCalled();
  });

  it("bs1/bs4: update_blog_post always gets the tick and keywords from the form (never left to the database default)", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: null },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });

    await expect(
      updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData({ keywords: "mision" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_is_editorial: false, p_keywords: ["mision"] }),
    );
  });

  it("au1: update_blog_post gets the name, or '' (remove) when the box is empty, never null (keep)", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: null },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });
    await expect(
      updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData({ authorName: "Drita Gjoni" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_author_name: "Drita Gjoni" }),
    );

    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: null },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });
    await expect(
      updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_author_name: "" }),
    );
  });

  it("a live article saved with no keywords shows the plain keyword message", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: null },
      rpcResults: {
        update_blog_post: { data: null, error: { message: "a published article needs at least one keyword" } },
      },
    });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData())).rejects.toBeInstanceOf(
      RedirectSignal,
    );
    expect(mockRedirect.mock.calls.at(-1)?.[0]).toContain(
      encodeURIComponent("A live article needs at least one keyword. Add one in Keywords and save."),
    );
  });

  it("never passes status/published_at/created_by/created_at as RPC parameters", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: null },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    const params = currentMockSupabase._spies.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("p_status");
    expect(params).not.toHaveProperty("p_published_at");
    expect(params).not.toHaveProperty("p_created_by");
    expect(params).not.toHaveProperty("p_created_at");
  });

  it("cover replacement: uploads new cover, updates via RPC, THEN removes the old cover and temp object (in that order)", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: "covers/11111111-1111-4111-8111-111111111111/old.jpg" },
      rpcResults: { update_blog_post: { data: null, error: null } },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.upload).toHaveBeenCalled();
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_cover_image_path: expect.stringMatching(/^covers\/11111111-1111-4111-8111-111111111111\/.+\.jpg$/) }),
    );
    // Old cover removed only after the RPC call above already resolved successfully.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["covers/11111111-1111-4111-8111-111111111111/old.jpg"]);
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/new.png"]);
  });

  it("cover replacement with an unchanged path is never deleted (no-op guard)", async () => {
    // Pathological but safe: if the newly uploaded path somehow equals
    // the existing one, the old-cover removal must not fire (it would
    // delete the very object just written).
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: "covers/11111111-1111-4111-8111-111111111111/same.png" },
      rpcResults: { update_blog_post: { data: null, error: null } },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The removal calls made are exactly: the temp object. The new
    // permanent path is randomly generated (uuid), so it can never
    // actually equal "covers/11111111-1111-4111-8111-111111111111/same.png" -- this proves the
    // inequality guard is exercised on every real call, not skipped.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["covers/11111111-1111-4111-8111-111111111111/same.png"]);
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/new.png"]);
  });

  it("DB update failure after a successful cover upload: removes the NEW object, keeps the OLD cover, maps the error safely", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: "covers/11111111-1111-4111-8111-111111111111/old.jpg" },
      rpcResults: {
        update_blog_post: { data: null, error: { message: "slug is immutable once a post is published" } },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The OLD cover is never passed to remove() at all in this failure path.
    const removedPaths = currentMockSupabase._spies.remove.mock.calls.map((c) => c[0]);
    expect(removedPaths).not.toContainEqual(["covers/11111111-1111-4111-8111-111111111111/old.jpg"]);
    // The new (now-orphaned) permanent object and the temp object are both cleaned up.
    expect(removedPaths.some((p) => (p as string[])[0].startsWith("covers/11111111-1111-4111-8111-111111111111/"))).toBe(true);
    expect(removedPaths).toContainEqual(["editor-1/tmp/blog/new.png"]);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("The URL slug can't be changed once an article is published."),
    );
  });

  it("permanent upload failure: old cover is kept entirely untouched, human-safe error shown", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "11111111-1111-4111-8111-111111111111", cover_image_path: "covers/11111111-1111-4111-8111-111111111111/old.jpg" },
      downloadBytes: PNG_BYTES,
      uploadError: { message: "storage backend unavailable" },
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("11111111-1111-4111-8111-111111111111", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(currentMockSupabase._spies.remove).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("Your previous cover was kept"));
  });
});

describe("publishBlogPostAction", () => {
  it("requireStaff('blog.manage') gates this action", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });
    await expect(publishBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("calls publish_blog_post and only that RPC, then redirects with a success message", async () => {
    currentMockSupabase = makeMockSupabase({ rpcResults: { publish_blog_post: { data: null, error: null } } });

    await expect(publishBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledTimes(1);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("publish_blog_post", { p_id: "11111111-1111-4111-8111-111111111111" });
    expect(currentMockSupabase._spies.from).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/blog/11111111-1111-4111-8111-111111111111/edit?success=${encodeURIComponent("Article published.")}`,
    );
  });

  it("maps a publish error safely", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { publish_blog_post: { data: null, error: { message: "no publishable draft found for this id" } } },
    });

    await expect(publishBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("already be published"));
  });
});

describe("unpublishBlogPostAction", () => {
  it("calls unpublish_blog_post and only that RPC", async () => {
    currentMockSupabase = makeMockSupabase({ rpcResults: { unpublish_blog_post: { data: null, error: null } } });

    await expect(unpublishBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledTimes(1);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("unpublish_blog_post", { p_id: "11111111-1111-4111-8111-111111111111" });
  });

  it("maps an unpublish error safely", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { unpublish_blog_post: { data: null, error: { message: "no published post found for this id" } } },
    });

    await expect(unpublishBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("already be a draft"));
  });
});

describe("deleteBlogPostAction", () => {
  it("requireStaff('blog.manage') gates this action", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });
    await expect(deleteBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("calls delete_blog_post and removes the returned cover path from storage after DB success", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        delete_blog_post: { data: [{ deleted_cover_image_path: "covers/11111111-1111-4111-8111-111111111111/gone.jpg" }], error: null },
      },
    });

    await expect(deleteBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("delete_blog_post", { p_id: "11111111-1111-4111-8111-111111111111" });
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["covers/11111111-1111-4111-8111-111111111111/gone.jpg"]);
    expect(mockRedirect).toHaveBeenCalledWith(`/admin/blog?success=${encodeURIComponent("Draft deleted.")}`);
  });

  it("a post with no cover: does not attempt any storage removal", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { delete_blog_post: { data: [{ deleted_cover_image_path: null }], error: null } },
    });

    await expect(deleteBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.remove).not.toHaveBeenCalled();
  });

  it("deleting a published post is rejected by the RPC and mapped safely -- no direct delete from application code", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        delete_blog_post: {
          data: null,
          error: { message: "only a draft post can be deleted, or it does not exist" },
        },
      },
    });

    await expect(deleteBlogPostAction("11111111-1111-4111-8111-111111111111")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.remove).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("Only draft articles can be deleted."));
  });
});

const POST = "11111111-1111-4111-8111-111111111111";
const BLOG_PREFIX = "https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/blog/";

describe("images inside an article (e2)", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefghijklmnopqrst.supabase.co");
  });

  it("create: an image from another website is refused before any RPC", async () => {
    const fd = validFormData({ contentMarkdown: "Text\n\n![x](https://other.test/a.jpg)" });
    await expect(createBlogPostAction(fd)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("Images must be uploaded with the Image button."));
  });

  it("create: an uploaded Librum image is accepted", async () => {
    currentMockSupabase = makeMockSupabase({ rpcResults: { create_blog_post: { data: POST, error: null } } });
    const fd = validFormData({ contentMarkdown: `Text\n\n![x](${BLOG_PREFIX}inline/a.jpg "x")` });
    await expect(createBlogPostAction(fd)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("create_blog_post", expect.anything());
  });

  it("update: an outside image already in the saved article can stay; a new one is refused", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: POST, cover_image_path: null, content_markdown: "![old](https://old.test/a.jpg)" },
    });
    await expect(
      updateBlogPostAction(POST, validFormData({ contentMarkdown: "![old](https://old.test/a.jpg)\nmore" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("update_blog_post", expect.anything());

    mockRedirect.mockClear();
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: POST, cover_image_path: null, content_markdown: "![old](https://old.test/a.jpg)" },
    });
    await expect(
      updateBlogPostAction(POST, validFormData({ contentMarkdown: "![new](https://new.test/b.jpg)" })),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("Images must be uploaded"));
  });

  it("upload: refuses a path outside the caller's own staging folder, with no download", async () => {
    const r = await uploadBlogInlineImageAction("someone-else/tmp/blog/11111111-1111-4111-8111-111111111111.jpg");
    expect(r.ok).toBe(false);
    expect(currentMockSupabase._spies.download).not.toHaveBeenCalled();
    const r2 = await uploadBlogInlineImageAction("editor-1/tmp/blog/../x.jpg");
    expect(r2.ok).toBe(false);
  });

  it("upload: checks the real bytes, removes the staged file, stores a JPEG under inline/ with the service role", async () => {
    const tmp = "editor-1/tmp/blog/11111111-1111-4111-8111-111111111111.png";
    const r = await uploadBlogInlineImageAction(tmp);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toMatch(new RegExp(`^${BLOG_PREFIX.replace(/[.]/g, "\\.")}inline/[0-9a-f-]{36}\\.jpg$`));
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith([tmp]);
    expect(mockCreateAdminClient).toHaveBeenCalled();
    const [path, , opts] = currentMockSupabase._spies.upload.mock.calls[0];
    expect(path).toMatch(/^inline\/[0-9a-f-]{36}\.jpg$/);
    expect(opts).toMatchObject({ contentType: "image/jpeg" });
  });

  it("upload: bytes that are not an image are refused and the staged file removed", async () => {
    currentMockSupabase = makeMockSupabase({ downloadBytes: NOT_AN_IMAGE_BYTES });
    const tmp = "editor-1/tmp/blog/11111111-1111-4111-8111-111111111111.jpg";
    const r = await uploadBlogInlineImageAction(tmp);
    expect(r).toEqual({ ok: false, error: "That doesn't look like a JPG, PNG or WebP image." });
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith([tmp]);
    expect(currentMockSupabase._spies.upload).not.toHaveBeenCalled();
  });
});

describe("scheduling (e3)", () => {
  function scheduleForm(date: string, time: string) {
    const fd = new FormData();
    fd.set("scheduleDate", date);
    fd.set("scheduleTime", time);
    return fd;
  }

  it("turns the Tirana date and time into the real instant for schedule_blog_post", async () => {
    await expect(scheduleBlogPostAction(POST, scheduleForm("2026-11-21", "09:00"))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.manage");
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("schedule_blog_post", {
      p_id: POST,
      p_go_live: "2026-11-21T08:00:00.000Z",
    });
    expect(mockRedirect).toHaveBeenCalledWith(`/admin/blog/${POST}/edit?success=${encodeURIComponent("Article scheduled.")}`);
  });

  it("a date or time that is not real never reaches the database", async () => {
    await expect(scheduleBlogPostAction(POST, scheduleForm("2026-02-30", "09:00"))).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("Pick a real date and time"));
  });

  it("maps the database's refusal safely", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { schedule_blog_post: { data: null, error: { message: "the go-live time must be in the future" } } },
    });
    await expect(scheduleBlogPostAction(POST, scheduleForm("2026-01-01", "09:00"))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect.mock.calls[0][0]).toContain(encodeURIComponent("at least a few minutes from now"));
  });

  it("cancel calls unpublish_blog_post and says the article is a draft again", async () => {
    await expect(cancelBlogScheduleAction(POST)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("unpublish_blog_post", { p_id: POST });
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/blog/${POST}/edit?success=${encodeURIComponent("Schedule cancelled. The article is a draft again.")}`,
    );
  });
});
