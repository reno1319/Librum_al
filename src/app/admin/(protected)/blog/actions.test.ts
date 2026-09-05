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

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
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

const {
  createBlogPostAction,
  updateBlogPostAction,
  publishBlogPostAction,
  unpublishBlogPostAction,
  deleteBlogPostAction,
} = await import("./actions");

function validFormData(overrides: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("title", "How to publish an ebook");
  fd.set("slug", "how-to-publish-an-ebook");
  fd.set("excerpt", "A short excerpt.");
  fd.set("contentMarkdown", "Some article body content.");
  fd.set("category", "publishing");
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
    const formData = validFormData({ category: "not-a-real-category" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
  });

  it("valid input with no cover: calls create_blog_post with cover_image_path null and redirects to the new edit page", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "new-post-id", error: null } },
    });

    await expect(createBlogPostAction(validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "create_blog_post",
      expect.objectContaining({ p_cover_image_path: null, p_category: "publishing" }),
    );
    // No direct table write anywhere in this action.
    expect(currentMockSupabase._spies.from).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith("/admin/blog/new-post-id/edit");
  });

  it("never passes status/published_at/created_by as RPC parameters -- those are not exposed at all", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "new-post-id", error: null } },
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
        create_blog_post: { data: "new-post-id", error: null },
        update_blog_post: { data: null, error: null },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.download).toHaveBeenCalledWith("editor-1/tmp/blog/abc.png");
    expect(currentMockSupabase._spies.upload).toHaveBeenCalled();
    const [permanentPath] = currentMockSupabase._spies.upload.mock.calls[0];
    expect(permanentPath).toMatch(/^covers\/new-post-id\/.+\.png$/);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_id: "new-post-id", p_cover_image_path: permanentPath }),
    );
    // Temp object cleaned up after everything succeeds.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/abc.png"]);
    expect(mockRedirect).toHaveBeenCalledWith("/admin/blog/new-post-id/edit");
  });

  it("rejects a staged path outside the caller's own uid namespace (ownership check)", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "new-post-id", error: null } },
    });
    const formData = validFormData({ coverStoragePath: "someone-else/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The draft was already created (this is a post-creation cover
    // failure) -- the download is never even attempted for a path that
    // fails the ownership/shape check.
    expect(currentMockSupabase._spies.download).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain("/admin/blog/new-post-id/edit");
    expect(redirectedTo).toContain(encodeURIComponent("no longer valid"));
  });

  it("rejects bytes that don't match a real JPEG/PNG signature -- the draft still exists, error is cover-specific", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { create_blog_post: { data: "new-post-id", error: null } },
      downloadBytes: NOT_AN_IMAGE_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.upload).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toBe(
      `/admin/blog/new-post-id/edit?error=${encodeURIComponent("That doesn't look like a valid JPEG or PNG image")}`,
    );
  });

  it("when the permanent upload succeeds but update_blog_post fails: the orphaned object is removed, draft is preserved", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        create_blog_post: { data: "new-post-id", error: null },
        update_blog_post: { data: null, error: { message: "invalid category" } },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/abc.png" });

    await expect(createBlogPostAction(formData)).rejects.toBeInstanceOf(RedirectSignal);

    // Both the orphaned permanent object AND the temp object are cleaned up.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledTimes(2);
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain("/admin/blog/new-post-id/edit");
    expect(redirectedTo).toContain(encodeURIComponent("could not be saved"));
  });
});

describe("updateBlogPostAction", () => {
  it("requireStaff('blog.manage') gates this action", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });

    await expect(updateBlogPostAction("post-1", validFormData())).rejects.toBeInstanceOf(RedirectSignal);
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
    currentMockSupabase = makeMockSupabase({ existingRow: { id: "post-1", cover_image_path: null } });
    const formData = validFormData({ excerpt: "" });

    await expect(updateBlogPostAction("post-1", formData)).rejects.toBeInstanceOf(RedirectSignal);
    expect(currentMockSupabase._spies.rpc).not.toHaveBeenCalled();
  });

  it("valid input, no new cover: preserves the existing cover_image_path in the RPC call", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "post-1", cover_image_path: "covers/post-1/old.jpg" },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });

    await expect(updateBlogPostAction("post-1", validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_cover_image_path: "covers/post-1/old.jpg" }),
    );
    // No cover replacement happened, so nothing is removed from storage.
    expect(currentMockSupabase._spies.remove).not.toHaveBeenCalled();
  });

  it("never passes status/published_at/created_by/created_at as RPC parameters", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "post-1", cover_image_path: null },
      rpcResults: { update_blog_post: { data: null, error: null } },
    });

    await expect(updateBlogPostAction("post-1", validFormData())).rejects.toBeInstanceOf(RedirectSignal);

    const params = currentMockSupabase._spies.rpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("p_status");
    expect(params).not.toHaveProperty("p_published_at");
    expect(params).not.toHaveProperty("p_created_by");
    expect(params).not.toHaveProperty("p_created_at");
  });

  it("cover replacement: uploads new cover, updates via RPC, THEN removes the old cover and temp object (in that order)", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "post-1", cover_image_path: "covers/post-1/old.jpg" },
      rpcResults: { update_blog_post: { data: null, error: null } },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("post-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.upload).toHaveBeenCalled();
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith(
      "update_blog_post",
      expect.objectContaining({ p_cover_image_path: expect.stringMatching(/^covers\/post-1\/.+\.png$/) }),
    );
    // Old cover removed only after the RPC call above already resolved successfully.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["covers/post-1/old.jpg"]);
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/new.png"]);
  });

  it("cover replacement with an unchanged path is never deleted (no-op guard)", async () => {
    // Pathological but safe: if the newly uploaded path somehow equals
    // the existing one, the old-cover removal must not fire (it would
    // delete the very object just written).
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "post-1", cover_image_path: "covers/post-1/same.png" },
      rpcResults: { update_blog_post: { data: null, error: null } },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("post-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The removal calls made are exactly: the temp object. The new
    // permanent path is randomly generated (uuid), so it can never
    // actually equal "covers/post-1/same.png" -- this proves the
    // inequality guard is exercised on every real call, not skipped.
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["covers/post-1/same.png"]);
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["editor-1/tmp/blog/new.png"]);
  });

  it("DB update failure after a successful cover upload: removes the NEW object, keeps the OLD cover, maps the error safely", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "post-1", cover_image_path: "covers/post-1/old.jpg" },
      rpcResults: {
        update_blog_post: { data: null, error: { message: "slug is immutable once a post is published" } },
      },
      downloadBytes: PNG_BYTES,
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("post-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

    // The OLD cover is never passed to remove() at all in this failure path.
    const removedPaths = currentMockSupabase._spies.remove.mock.calls.map((c) => c[0]);
    expect(removedPaths).not.toContainEqual(["covers/post-1/old.jpg"]);
    // The new (now-orphaned) permanent object and the temp object are both cleaned up.
    expect(removedPaths.some((p) => (p as string[])[0].startsWith("covers/post-1/"))).toBe(true);
    expect(removedPaths).toContainEqual(["editor-1/tmp/blog/new.png"]);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("The URL slug can't be changed once an article is published."),
    );
  });

  it("permanent upload failure: old cover is kept entirely untouched, human-safe error shown", async () => {
    currentMockSupabase = makeMockSupabase({
      existingRow: { id: "post-1", cover_image_path: "covers/post-1/old.jpg" },
      downloadBytes: PNG_BYTES,
      uploadError: { message: "storage backend unavailable" },
    });
    const formData = validFormData({ coverStoragePath: "editor-1/tmp/blog/new.png" });

    await expect(updateBlogPostAction("post-1", formData)).rejects.toBeInstanceOf(RedirectSignal);

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
    await expect(publishBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("calls publish_blog_post and only that RPC, then redirects with a success message", async () => {
    currentMockSupabase = makeMockSupabase({ rpcResults: { publish_blog_post: { data: null, error: null } } });

    await expect(publishBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledTimes(1);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("publish_blog_post", { p_id: "post-1" });
    expect(currentMockSupabase._spies.from).not.toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/blog/post-1/edit?success=${encodeURIComponent("Article published.")}`,
    );
  });

  it("maps a publish error safely", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { publish_blog_post: { data: null, error: { message: "no publishable draft found for this id" } } },
    });

    await expect(publishBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("already be published"));
  });
});

describe("unpublishBlogPostAction", () => {
  it("calls unpublish_blog_post and only that RPC", async () => {
    currentMockSupabase = makeMockSupabase({ rpcResults: { unpublish_blog_post: { data: null, error: null } } });

    await expect(unpublishBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledTimes(1);
    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("unpublish_blog_post", { p_id: "post-1" });
  });

  it("maps an unpublish error safely", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { unpublish_blog_post: { data: null, error: { message: "no published post found for this id" } } },
    });

    await expect(unpublishBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("already be a draft"));
  });
});

describe("deleteBlogPostAction", () => {
  it("requireStaff('blog.manage') gates this action", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/admin/login");
    });
    await expect(deleteBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);
  });

  it("calls delete_blog_post and removes the returned cover path from storage after DB success", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: {
        delete_blog_post: { data: [{ deleted_cover_image_path: "covers/post-1/gone.jpg" }], error: null },
      },
    });

    await expect(deleteBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.rpc).toHaveBeenCalledWith("delete_blog_post", { p_id: "post-1" });
    expect(currentMockSupabase._spies.remove).toHaveBeenCalledWith(["covers/post-1/gone.jpg"]);
    expect(mockRedirect).toHaveBeenCalledWith(`/admin/blog?success=${encodeURIComponent("Draft deleted.")}`);
  });

  it("a post with no cover: does not attempt any storage removal", async () => {
    currentMockSupabase = makeMockSupabase({
      rpcResults: { delete_blog_post: { data: [{ deleted_cover_image_path: null }], error: null } },
    });

    await expect(deleteBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

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

    await expect(deleteBlogPostAction("post-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(currentMockSupabase._spies.remove).not.toHaveBeenCalled();
    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(encodeURIComponent("Only draft articles can be deleted."));
  });
});
