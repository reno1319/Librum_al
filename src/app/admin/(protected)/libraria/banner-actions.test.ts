import { beforeEach, describe, expect, it, vi } from "vitest";

// LR1 patch 3: saveBannerSlide, deleteBannerSlide and moveBannerSlide.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
const revalidated: string[] = [];
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => void revalidated.push(p) }));

// A picture is "good" unless its name says otherwise.
vi.mock("@/lib/cover-image", () => ({
  detectCoverImageKind: async (file: File) => (file.name.startsWith("bad") ? null : "jpeg"),
}));
vi.mock("@/lib/cover-resize", () => ({
  IMAGE_CACHE_CONTROL_SECONDS: "604800",
  shrinkImageToJpeg: async (bytes: Buffer, size: { width: number }) =>
    bytes.toString() === "unreadable" ? null : Buffer.from(`shrunk-${size.width}`),
}));

let uploadFails = false;
const uploads: { path: string; bytes: string; opts: unknown }[] = [];
const removals: string[][] = [];
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("libraria");
        return {
          upload: (path: string, bytes: Buffer, opts: unknown) => {
            uploads.push({ path, bytes: bytes.toString(), opts });
            return Promise.resolve({ error: uploadFails ? { message: "boom" } : null });
          },
          remove: (paths: string[]) => (removals.push(paths), Promise.resolve({ error: null })),
        };
      },
    },
  }),
}));

let stored: { data: unknown; error: { message: string } | null };
let rpcResult: { data: unknown; error: { code?: string; message: string } | null };
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      from: () => {
        const chain = { select: () => chain, eq: () => chain, maybeSingle: () => Promise.resolve(stored) };
        return chain;
      },
      rpc: (name: string, args: Record<string, unknown>) => (rpcCalls.push({ name, args }), Promise.resolve(rpcResult)),
    }),
}));

const { saveBannerSlide, deleteBannerSlide, moveBannerSlide } = await import("./banner-actions");

async function target(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectSignal) return decodeURIComponent(e.message);
    throw e;
  }
  throw new Error("no redirect");
}

const BOOK = "11111111-1111-4111-8111-111111111111";
const SLIDE = "22222222-2222-4222-8222-222222222222";
const OLD_WIDE = "slides/33333333-3333-4333-8333-333333333333.jpg";
const OLD_PHONE = "slides/44444444-4444-4444-8444-444444444444.jpg";
const SLIDE_PATH = /^slides\/[0-9a-f-]{36}\.jpg$/;

function file(name: string, body = "img", size?: number): File {
  const f = new File([body], name, { type: "image/jpeg" });
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
}

function slideForm(fields: Record<string, string | File> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ bookId: BOOK, description: "Një libër i ri.", ...fields })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "staff-1", role: "owner" });
  uploadFails = false;
  uploads.length = 0;
  removals.length = 0;
  rpcCalls.length = 0;
  revalidated.length = 0;
  stored = { data: { image_path: OLD_WIDE, phone_image_path: OLD_PHONE }, error: null };
  rpcResult = { data: SLIDE, error: null };
});

describe("saveBannerSlide", () => {
  it("a denied staff member stops before anything", async () => {
    mockRequireStaff.mockRejectedValueOnce(new RedirectSignal("/admin"));
    await expect(saveBannerSlide(slideForm({ picture: file("a.jpg") }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(uploads).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("adds a slide: shrinks and uploads both pictures, then saves", async () => {
    const to = await target(
      saveBannerSlide(slideForm({ picture: file("a.jpg"), phonePicture: file("b.png"), tag: "E re", startsOn: "2026-11-20" })),
    );
    expect(to).toBe("/admin/libraria?success=Slide saved.#banner-slides");
    expect(uploads.map((u) => u.bytes)).toEqual(["shrunk-2400", "shrunk-1200"]);
    for (const u of uploads) {
      expect(u.path).toMatch(SLIDE_PATH);
      expect(u.opts).toEqual({ contentType: "image/jpeg", cacheControl: "604800" });
    }
    expect(rpcCalls).toEqual([
      {
        name: "staff_save_libraria_banner_slide",
        args: {
          p_id: null,
          p_book_id: BOOK,
          p_description: "Një libër i ri.",
          p_tag: "E re",
          p_image_path: uploads[0].path,
          p_phone_image_path: uploads[1].path,
          p_starts_on: "2026-11-20",
          p_ends_on: null,
        },
      },
    ]);
    expect(removals).toEqual([]);
    expect(revalidated).toEqual(["/admin/libraria", "/librari"]);
  });

  it("a new slide needs a picture", async () => {
    expect(await target(saveBannerSlide(slideForm()))).toBe("/admin/libraria?error=Choose a picture.");
    expect(rpcCalls).toEqual([]);
  });

  it("a form problem is named before any upload", async () => {
    expect(await target(saveBannerSlide(slideForm({ description: "", picture: file("a.jpg") })))).toBe(
      "/admin/libraria?error=Write the one-line description.",
    );
    expect(uploads).toEqual([]);
  });

  it("refuses a picture that is not a JPG or PNG, or is 5 MB or more, before any upload", async () => {
    expect(await target(saveBannerSlide(slideForm({ picture: file("bad.gif") })))).toBe(
      "/admin/libraria?error=Each picture must be a JPG or PNG under 5 MB.",
    );
    expect(await target(saveBannerSlide(slideForm({ picture: file("a.jpg"), phonePicture: file("b.jpg", "x", 5 * 1024 * 1024 + 1) })))).toBe(
      "/admin/libraria?error=Each picture must be a JPG or PNG under 5 MB.",
    );
    expect(await target(saveBannerSlide(slideForm({ picture: file("a.jpg", "unreadable") })))).toBe(
      "/admin/libraria?error=Couldn’t read that picture. Please choose another.",
    );
    expect(uploads).toEqual([]);
  });

  it("a failed upload removes the one that did upload and saves nothing", async () => {
    uploadFails = true;
    expect(await target(saveBannerSlide(slideForm({ picture: file("a.jpg") })))).toBe(
      "/admin/libraria?error=Couldn’t save the slide. Please try again.",
    );
    expect(rpcCalls).toEqual([]);
  });

  it.each([
    ["LB538", "At most 6 slides can show on the same day. Change the days or delete a slide."],
    ["LB539", "That book is not on Libraria now."],
    ["XX000", "Couldn’t save the slide. Please try again."],
  ])("a refused save (%s) removes the new pictures and says why", async (code, message) => {
    rpcResult = { data: null, error: { code, message: "refused" } };
    expect(await target(saveBannerSlide(slideForm({ picture: file("a.jpg") })))).toBe(`/admin/libraria?error=${message}`);
    expect(removals).toEqual([[uploads[0].path]]);
    expect(revalidated).toEqual([]);
  });

  it("edit without new pictures keeps both stored ones and removes nothing", async () => {
    expect(await target(saveBannerSlide(slideForm({ slideId: SLIDE })))).toBe("/admin/libraria?success=Slide saved.#banner-slides");
    expect(uploads).toEqual([]);
    expect(rpcCalls[0].args).toMatchObject({ p_id: SLIDE, p_image_path: OLD_WIDE, p_phone_image_path: OLD_PHONE });
    expect(removals).toEqual([]);
  });

  it("edit with a new wide picture removes the old wide one after the save", async () => {
    await target(saveBannerSlide(slideForm({ slideId: SLIDE, picture: file("a.jpg") })));
    expect(rpcCalls[0].args).toMatchObject({ p_image_path: uploads[0].path, p_phone_image_path: OLD_PHONE });
    expect(removals).toEqual([[OLD_WIDE]]);
  });

  it("edit with Remove the phone picture clears it and removes its file", async () => {
    await target(saveBannerSlide(slideForm({ slideId: SLIDE, removePhonePicture: "on" })));
    expect(rpcCalls[0].args).toMatchObject({ p_image_path: OLD_WIDE, p_phone_image_path: null });
    expect(removals).toEqual([[OLD_PHONE]]);
  });

  it("an edit error goes back to the edit form", async () => {
    rpcResult = { data: null, error: { code: "LB538", message: "refused" } };
    expect(await target(saveBannerSlide(slideForm({ slideId: SLIDE })))).toBe(
      `/admin/libraria?edit=${SLIDE}&error=At most 6 slides can show on the same day. Change the days or delete a slide.`,
    );
    expect(removals).toEqual([]);
  });

  it("editing a slide that is gone says so", async () => {
    stored = { data: null, error: null };
    expect(await target(saveBannerSlide(slideForm({ slideId: SLIDE })))).toBe("/admin/libraria?error=That slide no longer exists.");
    stored = { data: { image_path: OLD_WIDE, phone_image_path: null }, error: null };
    rpcResult = { data: null, error: null };
    expect(await target(saveBannerSlide(slideForm({ slideId: SLIDE })))).toBe("/admin/libraria?error=That slide no longer exists.");
  });
});

describe("deleteBannerSlide", () => {
  function del(id: string) {
    const fd = new FormData();
    fd.set("slideId", id);
    return deleteBannerSlide(fd);
  }

  it("deletes the slide, then both its pictures", async () => {
    rpcResult = { data: true, error: null };
    expect(await target(del(SLIDE))).toBe("/admin/libraria?success=Slide deleted.#banner-slides");
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([{ name: "staff_delete_libraria_banner_slide", args: { p_id: SLIDE } }]);
    expect(removals).toEqual([[OLD_WIDE, OLD_PHONE]]);
  });

  it("a bad id, a gone slide or a failed delete removes no pictures", async () => {
    expect(await target(del("nope"))).toBe("/admin/libraria?error=That slide no longer exists.#banner-slides");
    rpcResult = { data: false, error: null };
    expect(await target(del(SLIDE))).toBe("/admin/libraria?error=That slide no longer exists.#banner-slides");
    rpcResult = { data: null, error: { message: "boom" } };
    expect(await target(del(SLIDE))).toBe("/admin/libraria?error=Couldn’t delete the slide. Please try again.#banner-slides");
    expect(removals).toEqual([]);
  });
});

describe("moveBannerSlide", () => {
  function move(id: string, direction: string) {
    const fd = new FormData();
    fd.set("slideId", id);
    fd.set("direction", direction);
    return moveBannerSlide(fd);
  }

  it("moves up or down", async () => {
    rpcResult = { data: true, error: null };
    expect(await target(move(SLIDE, "up"))).toBe("/admin/libraria?success=Slide moved.#banner-slides");
    await target(move(SLIDE, "down"));
    expect(rpcCalls.map((c) => c.args)).toEqual([
      { p_id: SLIDE, p_up: true },
      { p_id: SLIDE, p_up: false },
    ]);
  });

  it("refuses a bad id or direction, and says when the move failed", async () => {
    expect(await target(move("nope", "up"))).toBe("/admin/libraria?error=Couldn’t move the slide. Please try again.#banner-slides");
    expect(await target(move(SLIDE, "left"))).toBe("/admin/libraria?error=Couldn’t move the slide. Please try again.#banner-slides");
    expect(rpcCalls).toEqual([]);
    rpcResult = { data: null, error: { message: "boom" } };
    expect(await target(move(SLIDE, "up"))).toBe("/admin/libraria?error=Couldn’t move the slide. Please try again.#banner-slides");
  });
});
