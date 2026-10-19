import { beforeEach, describe, expect, it, vi } from "vitest";

// PEN-NAMES-1: Dashboard > Pen names actions against a recording double.
// Every query records which client ran it (the author's session or the
// server-only pen name writer), its table and builder calls; `respond`
// decides each result.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Op = { method: string; args: unknown[] };
type Query = { client: "session" | "writer"; table: string; ops: Op[] };
type Result = { data?: unknown; error?: { code?: string } | null; count?: number };

let queries: Query[] = [];
let respond: (q: Query) => Result;
let storageCalls: { client: string; bucket: string; op: string; path: unknown }[] = [];
let stagedBytes: Buffer | null;

function method(q: Query, name: string): Op | undefined {
  return q.ops.find((op) => op.method === name);
}

function recordingClient(client: Query["client"]) {
  return {
    from(table: string) {
      const q: Query = { client, table, ops: [] };
      const proxy: object = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") {
              return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
                queries.push(q);
                return Promise.resolve({ data: null, error: null, ...respond(q) }).then(onFulfilled, onRejected);
              };
            }
            return (...args: unknown[]) => {
              q.ops.push({ method: String(prop), args });
              return proxy;
            };
          },
        },
      );
      return proxy;
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string) => (storageCalls.push({ client, bucket, op: "upload", path }), { error: null }),
        remove: async (paths: unknown) => (storageCalls.push({ client, bucket, op: "remove", path: paths }), { error: null }),
        download: async (path: string) => {
          storageCalls.push({ client, bucket, op: "download", path });
          return stagedBytes ? { data: new Blob([new Uint8Array(stagedBytes)]), error: null } : { data: null, error: { message: "x" } };
        },
      }),
    },
  };
}

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const PEN_ID = "f0000000-0000-4000-8000-000000000002";
const OLD_PHOTO = "d0000000-0000-4000-8000-000000000009/pen-name.png";

const sessionClient = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  ...recordingClient("session"),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
const writerClient = recordingClient("writer");
vi.mock("@/lib/pen-name-write-client", () => ({ createPenNameWriteClient: () => writerClient }));

const { updatePenName, deletePenName } = await import("./actions");

let ownRow: Record<string, unknown> | null;

function defaultRespond(q: Query): Result {
  if (q.client === "session" && q.table === "pen_names" && method(q, "select") && !method(q, "update")) {
    return { data: ownRow };
  }
  if (q.client === "session" && q.table === "pen_names" && method(q, "update")) return { data: [{ id: PEN_ID }] };
  if (q.client === "writer" && q.table === "pen_names" && method(q, "update")) {
    const avatar = (method(q, "update")!.args[0] as { avatar_path: unknown }).avatar_path;
    return { data: [{ id: PEN_ID, avatar_path: avatar }] };
  }
  if (q.client === "session" && ["books", "series", "bundles"].includes(q.table)) return { count: 0 };
  if (q.client === "writer" && q.table === "pen_names" && method(q, "delete")) return { data: [{ id: PEN_ID }] };
  throw new Error(`unexpected query: ${q.client} ${q.table} ${q.ops.map((o) => o.method).join(".")}`);
}

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const value of Array.isArray(v) ? v : [v]) fd.append(k, value);
  }
  return fd;
}

async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return decodeURIComponent(error.target);
    throw error;
  }
  throw new Error("expected a redirect");
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

beforeEach(() => {
  queries = [];
  storageCalls = [];
  stagedBytes = null;
  respond = defaultRespond;
  ownRow = { id: PEN_ID, is_default: false, avatar_path: null };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updatePenName", () => {
  it("writes name, bio and links with the SESSION client, filtered by id and the session author", async () => {
    const target = await redirectOf(
      updatePenName(PEN_ID, form({ name: "  Jo Pen ", bio: " Bio ", links: ["https://a.example", "", ""] })),
    );
    expect(target).toBe("/dashboard/pen-names?success=Pen name saved.");
    const update = queries.find((q) => q.client === "session" && method(q, "update"))!;
    expect(method(update, "update")!.args[0]).toEqual({ name: "Jo Pen", bio: "Bio", links: ["https://a.example"] });
    expect(update.ops).toContainEqual({ method: "eq", args: ["id", PEN_ID] });
    expect(update.ops).toContainEqual({ method: "eq", args: ["author_id", USER_ID] });
    expect(queries.some((q) => q.client === "writer")).toBe(false);
  });

  it("an empty bio is stored as null", async () => {
    await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", bio: "  " })));
    const update = queries.find((q) => q.client === "session" && method(q, "update"))!;
    expect((method(update, "update")!.args[0] as { bio: unknown }).bio).toBeNull();
  });

  it("refuses a non-https link or more than 3 before any write", async () => {
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", links: ["http://a.example"] })))).toContain("https://");
    expect(
      await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", links: ["https://a.e", "https://b.e", "https://c.e", "https://d.e"] }))),
    ).toContain("at most 3");
    expect(queries.some((q) => method(q, "update"))).toBe(false);
  });

  it("a name another of the author's pen names uses (23505) gets the clear message", async () => {
    respond = (q) =>
      q.client === "session" && method(q, "update") ? { data: null, error: { code: "23505" } } : defaultRespond(q);
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Taken" })))).toBe(
      "/dashboard/pen-names?error=You already use this name as one of your pen names. Choose another name, or rename that pen name first.",
    );
  });

  it("not the author's own pen name -> refused, nothing written", async () => {
    ownRow = null;
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo" })))).toContain("?error=");
    expect(queries.some((q) => method(q, "update"))).toBe(false);
  });

  it("a malformed id is refused before any query", async () => {
    expect(await redirectOf(updatePenName("../x", form({ name: "Jo" })))).toContain("?error=");
    expect(queries).toEqual([]);
  });

  it("a photo: validated, uploaded by the WRITER under a fresh random folder, path written by the writer, old photo removed", async () => {
    ownRow = { id: PEN_ID, is_default: false, avatar_path: OLD_PHOTO };
    stagedBytes = PNG;
    const staged = `${USER_ID}/tmp/avatar/aaaaaaaa-0000-4000-8000-000000000001.png`;
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", avatarStoragePath: staged })))).toBe(
      "/dashboard/pen-names?success=Pen name saved.",
    );
    const upload = storageCalls.find((c) => c.op === "upload")!;
    expect(upload.client).toBe("writer");
    expect(upload.bucket).toBe("avatars");
    expect(upload.path).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/pen-name\.png$/);
    expect(upload.path).not.toContain(USER_ID);
    const write = queries.find((q) => q.client === "writer" && method(q, "update"))!;
    expect(method(write, "update")!.args[0]).toEqual({ avatar_path: upload.path });
    expect(write.ops).toContainEqual({ method: "eq", args: ["author_id", USER_ID] });
    expect(storageCalls).toContainEqual({ client: "writer", bucket: "avatars", op: "remove", path: [OLD_PHOTO] });
    expect(storageCalls).toContainEqual({ client: "session", bucket: "manuscripts", op: "remove", path: [staged] });
  });

  it("a staged path outside the author's own staging folder is refused before download", async () => {
    stagedBytes = PNG;
    const target = await redirectOf(
      updatePenName(PEN_ID, form({ name: "Jo", avatarStoragePath: "someone-else/tmp/avatar/x.png" })),
    );
    expect(target).toContain("no longer valid");
    expect(storageCalls).toEqual([]);
  });

  it("bytes that are not a JPEG or PNG are refused", async () => {
    stagedBytes = Buffer.from("not an image at all");
    const target = await redirectOf(
      updatePenName(PEN_ID, form({ name: "Jo", avatarStoragePath: `${USER_ID}/tmp/avatar/x.png` })),
    );
    expect(target).toContain("valid JPEG or PNG");
    expect(storageCalls.some((c) => c.op === "upload")).toBe(false);
  });

  it("Remove photo clears the path through the writer and removes the object", async () => {
    ownRow = { id: PEN_ID, is_default: false, avatar_path: OLD_PHOTO };
    await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", removePhoto: "on" })));
    const write = queries.find((q) => q.client === "writer" && method(q, "update"))!;
    expect(method(write, "update")!.args[0]).toEqual({ avatar_path: null });
    expect(storageCalls).toContainEqual({ client: "writer", bucket: "avatars", op: "remove", path: [OLD_PHOTO] });
  });
});

// r4 (17a): a default pen name may hold the profile's own photo key
// ("<account id>/avatar.<ext>", copied by the migration). It is the same
// object profiles.avatar_path names, so the Pen names page never removes
// it -- it only stops pointing at it.
describe("updatePenName: a default pen name holding the profile photo", () => {
  const PROFILE_PHOTO = `${USER_ID}/avatar.png`;

  it("a new photo replaces it on the row, but the shared profile object is not removed", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: PROFILE_PHOTO };
    stagedBytes = PNG;
    expect(
      await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", avatarStoragePath: `${USER_ID}/tmp/avatar/x.png` }))),
    ).toBe("/dashboard/pen-names?success=Pen name saved.");
    const removedAvatars = storageCalls.filter((c) => c.bucket === "avatars" && c.op === "remove");
    expect(removedAvatars).toEqual([]);
    const write = queries.find((q) => q.client === "writer" && method(q, "update"))!;
    expect((method(write, "update")!.args[0] as { avatar_path: string }).avatar_path).toMatch(/\/pen-name\.png$/);
  });

  it("Remove photo clears the row only; the shared profile object stays", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: PROFILE_PHOTO };
    await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", removePhoto: "on" })));
    const write = queries.find((q) => q.client === "writer" && method(q, "update"))!;
    expect(method(write, "update")!.args[0]).toEqual({ avatar_path: null });
    expect(storageCalls.filter((c) => c.op === "remove")).toEqual([]);
  });
});

describe("deletePenName", () => {
  it("deletes an unused, non-default pen name through the writer, by id, author and is_default=false", async () => {
    expect(await redirectOf(deletePenName(PEN_ID))).toBe("/dashboard/pen-names?success=Pen name deleted.");
    const del = queries.find((q) => q.client === "writer" && method(q, "delete"))!;
    expect(del.ops).toContainEqual({ method: "eq", args: ["id", PEN_ID] });
    expect(del.ops).toContainEqual({ method: "eq", args: ["author_id", USER_ID] });
    expect(del.ops).toContainEqual({ method: "eq", args: ["is_default", false] });
  });

  it("the default pen name is never deleted", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    expect(await redirectOf(deletePenName(PEN_ID))).toContain("default pen name can't be deleted");
    expect(queries.some((q) => method(q, "delete"))).toBe(false);
  });

  it("a pen name used by a book, series or bundle is not deleted", async () => {
    respond = (q) => (q.table === "series" ? { count: 1 } : defaultRespond(q));
    expect(await redirectOf(deletePenName(PEN_ID))).toContain("still used");
    expect(queries.some((q) => method(q, "delete"))).toBe(false);
  });

  it("a foreign-key refusal (used after all) gets the same message", async () => {
    respond = (q) => (method(q, "delete") ? { data: null, error: { code: "23503" } } : defaultRespond(q));
    expect(await redirectOf(deletePenName(PEN_ID))).toContain("still used");
  });

  it("its photo is removed after the delete", async () => {
    ownRow = { id: PEN_ID, is_default: false, avatar_path: OLD_PHOTO };
    await redirectOf(deletePenName(PEN_ID));
    expect(storageCalls).toEqual([{ client: "writer", bucket: "avatars", op: "remove", path: [OLD_PHOTO] }]);
  });
});
