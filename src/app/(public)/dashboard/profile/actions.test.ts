import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 LAUNCH-FIX-1A AVATAR-1: focused coverage of
// resolveAvatarInput()'s own validation branches (temp-path ownership
// check, size limit, real byte-signature check) via updateProfile() --
// the same "extract a pure-ish decision, exercise it through the
// public entry point" approach dashboard/books/actions.test.ts already
// uses for resolveCoverInput()/resolveManuscriptInput(). Real magic
// bytes are used rather than mocking detectCoverImageKind -- it's
// cheap, already-real, and this repo's own established discipline (see
// that file's own header comment) is to satisfy real validators for
// real rather than fake them.
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

const USER_ID = "11111111-1111-1111-1111-111111111111";

// First 8 bytes are all detectCoverImageKind() ever reads (src/lib/
// cover-image.ts) -- a real PNG signature is enough, no need for a
// fully valid image.
const REAL_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const NOT_AN_IMAGE_BYTES = Buffer.from("this is definitely not an image file");

const mockGetUser = vi.fn();
const mockDownload = vi.fn();
const mockRemove = vi.fn();
const mockUploadAvatar = vi.fn();
const mockUpdateProfile = vi.fn();
// LIBRUM 2.0 AUTHOR-1A: the role lookup updateProfile() now does before
// anything else, to decide (server-side, never trusting the form) whether
// this request may touch public_author_name at all.
const mockCurrentProfileSingle = vi.fn();

function makeFakeBlob(bytes: Buffer) {
  return { arrayBuffer: () => Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)) };
}

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    storage: {
      from: (bucket: string) => {
        if (bucket === "manuscripts") {
          return { download: mockDownload, remove: mockRemove };
        }
        if (bucket === "avatars") {
          return { upload: mockUploadAvatar };
        }
        throw new Error(`unexpected bucket in this focused test: ${bucket}`);
      },
    },
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table in this focused test: ${table}`);
      return {
        select: () => ({
          eq: () => ({ single: () => mockCurrentProfileSingle() }),
        }),
        update: (payload: unknown) => ({
          eq: () => mockUpdateProfile(payload),
        }),
      };
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { updateProfile } = await import("./actions");

function formDataWith(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("updateProfile / resolveAvatarInput: AVATAR-1 direct-Storage transport", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
    mockDownload.mockReset();
    mockRemove.mockReset().mockResolvedValue({ error: null });
    mockUploadAvatar.mockReset().mockResolvedValue({ error: null });
    mockUpdateProfile.mockReset().mockResolvedValue({ error: null });
    mockCurrentProfileSingle.mockReset().mockResolvedValue({ data: { role: "author" }, error: null });
  });

  it("resolves a valid temp reference: downloads, uploads to the canonical avatars path, updates the profile, and cleans up the temp object", async () => {
    const tempPath = `${USER_ID}/tmp/avatar/some-uuid.png`;
    mockDownload.mockResolvedValue({ data: makeFakeBlob(REAL_PNG_BYTES), error: null });

    const formData = formDataWith({
      displayName: "Jane Author",
      bio: "Writes things.",
      avatarStoragePath: tempPath,
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockDownload).toHaveBeenCalledWith(tempPath);
    expect(mockUploadAvatar).toHaveBeenCalledWith(
      `${USER_ID}/avatar.png`,
      expect.any(Buffer),
      expect.objectContaining({ contentType: "image/png", upsert: true }),
    );
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ avatar_path: `${USER_ID}/avatar.png` }),
    );
    // Cleanup only after the canonical write is confirmed -- same
    // ordering as createBook/updateBook's own temp cleanup.
    expect(mockRemove).toHaveBeenCalledWith([tempPath]);
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/profile?success=1");
  });

  it("rejects a temp reference outside the caller's own owner-scoped namespace, without ever downloading it", async () => {
    const someoneElsesPath = "22222222-2222-2222-2222-222222222222/tmp/avatar/x.png";
    const formData = formDataWith({
      displayName: "Jane Author",
      avatarStoragePath: someoneElsesPath,
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("no longer valid")),
    );
    expect(mockDownload).not.toHaveBeenCalled();
  });

  it("rejects bytes over the 5MB limit even when the temp reference itself looks valid", async () => {
    const tempPath = `${USER_ID}/tmp/avatar/big.png`;
    const oversized = Buffer.concat([REAL_PNG_BYTES, Buffer.alloc(5 * 1024 * 1024)]);
    mockDownload.mockResolvedValue({ data: makeFakeBlob(oversized), error: null });

    const formData = formDataWith({
      displayName: "Jane Author",
      avatarStoragePath: tempPath,
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("larger than the 5 MB limit")),
    );
    expect(mockUploadAvatar).not.toHaveBeenCalled();
  });

  it("rejects bytes that don't carry a real JPEG/PNG signature, regardless of the temp path's own extension", async () => {
    const tempPath = `${USER_ID}/tmp/avatar/fake.png`;
    mockDownload.mockResolvedValue({ data: makeFakeBlob(NOT_AN_IMAGE_BYTES), error: null });

    const formData = formDataWith({
      displayName: "Jane Author",
      avatarStoragePath: tempPath,
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("doesn't look like a valid JPEG or PNG image")),
    );
    expect(mockUploadAvatar).not.toHaveBeenCalled();
  });

  it("updates name/bio only, with no Storage calls at all, when no avatar reference is submitted", async () => {
    const formData = formDataWith({ displayName: "Jane Author", bio: "Writes things." });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockUploadAvatar).not.toHaveBeenCalled();
    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: "Jane Author", bio: "Writes things." }),
    );
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/profile?success=1");
  });
});

// LIBRUM 2.0 AUTHOR-1A: updateProfile()'s new public_author_name
// authorization + validation branch. Role is always re-derived from the
// authenticated profile's own row (mockCurrentProfileSingle), never from
// anything the form submits -- every "reader" case here still submits
// whatever FormData it likes, proving the server ignores it regardless.
describe("updateProfile: public_author_name (LIBRUM 2.0 AUTHOR-1A)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
    mockDownload.mockReset();
    mockRemove.mockReset().mockResolvedValue({ error: null });
    mockUploadAvatar.mockReset().mockResolvedValue({ error: null });
    mockUpdateProfile.mockReset().mockResolvedValue({ error: null });
    mockCurrentProfileSingle.mockReset().mockResolvedValue({ data: { role: "author" }, error: null });
  });

  it("author can update account name and public author name independently, in one request", async () => {
    const formData = formDataWith({
      displayName: "Renato Kalemi",
      bio: "Writes things.",
      publicAuthorName: "R. Kalemi",
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        display_name: "Renato Kalemi",
        bio: "Writes things.",
        public_author_name: "R. Kalemi",
      }),
    );
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/profile?success=1");
  });

  it("account name change alone (publicAuthorName field absent) never touches public_author_name -- no accidental overwrite", async () => {
    const formData = formDataWith({ displayName: "Renato Kalemi Jr.", bio: "" });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdateProfile.mock.calls[0][0];
    expect(payload).toHaveProperty("display_name", "Renato Kalemi Jr.");
    expect(payload).not.toHaveProperty("public_author_name");
  });

  it("author submitting a blank public author name is rejected -- account name is NOT saved either (atomic failure, not a partial save)", async () => {
    const formData = formDataWith({ displayName: "Renato Kalemi", publicAuthorName: "" });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Public author name can't be empty")),
    );
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it("whitespace-only public author name is rejected the same way as blank", async () => {
    const formData = formDataWith({ displayName: "Renato Kalemi", publicAuthorName: "   " });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Public author name can't be empty")),
    );
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it("public author name over 120 characters is rejected", async () => {
    const formData = formDataWith({
      displayName: "Renato Kalemi",
      publicAuthorName: "x".repeat(121),
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(
        encodeURIComponent("Public author name must be 120 characters or fewer"),
      ),
    );
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it("public author name at exactly 120 characters is accepted", async () => {
    const exactly120 = "x".repeat(120);
    const formData = formDataWith({ displayName: "Renato Kalemi", publicAuthorName: exactly120 });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ public_author_name: exactly120 }),
    );
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/profile?success=1");
  });

  it("trims leading/trailing whitespace before validating and saving", async () => {
    const formData = formDataWith({
      displayName: "Renato Kalemi",
      publicAuthorName: "  R. Kalemi  ",
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ public_author_name: "R. Kalemi" }),
    );
  });

  it("a reader's crafted FormData including publicAuthorName is silently ignored -- never written, never an error", async () => {
    mockCurrentProfileSingle.mockResolvedValue({ data: { role: "reader" }, error: null });
    const formData = formDataWith({
      displayName: "A Reader",
      publicAuthorName: "Sneaky Pen Name",
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdateProfile.mock.calls[0][0];
    expect(payload).not.toHaveProperty("public_author_name");
    expect(payload).toHaveProperty("display_name", "A Reader");
    // No rejection either -- the field is just silently irrelevant for a
    // reader, not an error condition.
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/profile?success=1");
  });

  it("a reader can still update the profile fields they ARE permitted to change", async () => {
    mockCurrentProfileSingle.mockResolvedValue({ data: { role: "reader" }, error: null });
    const formData = formDataWith({ displayName: "A Reader", bio: "I like reading." });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockUpdateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: "A Reader", bio: "I like reading." }),
    );
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/profile?success=1");
  });

  it("a profile-role read failure fails closed: public_author_name is never written even if the form includes it", async () => {
    mockCurrentProfileSingle.mockResolvedValue({ data: null, error: { message: "read failed" } });
    const formData = formDataWith({ displayName: "Renato Kalemi", publicAuthorName: "R. Kalemi" });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdateProfile.mock.calls[0][0];
    expect(payload).not.toHaveProperty("public_author_name");
  });

  it("the DB update touches only the intended columns -- no unrelated column (role, stripe_account_id, id) is ever included", async () => {
    const formData = formDataWith({
      displayName: "Renato Kalemi",
      bio: "Writes things.",
      publicAuthorName: "R. Kalemi",
    });

    await expect(updateProfile(formData)).rejects.toBeInstanceOf(RedirectSignal);

    const payload = mockUpdateProfile.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["bio", "display_name", "public_author_name"].sort(),
    );
  });
});
