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
let storageCalls: { client: string; bucket: string; op: string; path: unknown; bytes?: Buffer; opts?: unknown }[] = [];
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
        upload: async (path: string, bytes: Buffer, opts: unknown) => (
          storageCalls.push({ client, bucket, op: "upload", path, bytes, opts }), { error: null }
        ),
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
const NEW_ID = "f0000000-0000-4000-8000-000000000003";
const OLD_PHOTO = "d0000000-0000-4000-8000-000000000009/pen-name.png";

const sessionClient = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  ...recordingClient("session"),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
const writerClient = recordingClient("writer");
let resolveCalls: unknown[][] = [];
let resolveResult: unknown;
vi.mock("@/lib/pen-name-write-client", () => ({
  createPenNameWriteClient: () => writerClient,
  resolveOwnPenNameId: async (...args: unknown[]) => (resolveCalls.push(args), resolveResult),
}));

const { updatePenName, deletePenName, createPenName } = await import("./actions");

let ownRow: Record<string, unknown> | null;
let profileRole: string;
let accountKind: string;
let ownPenNameIds: string[];
let profileWriteRows: unknown;

function defaultRespond(q: Query): Result {
  if (q.client === "session" && q.table === "pen_names" && method(q, "select") && !method(q, "update")) {
    return method(q, "maybeSingle") ? { data: ownRow } : { data: ownPenNameIds.map((id) => ({ id })) };
  }
  if (q.client === "session" && q.table === "profiles" && method(q, "update")) return { data: profileWriteRows };
  if (q.client === "session" && q.table === "profiles") return { data: { role: profileRole, account_kind: accountKind } };
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

// COVERS-1: a real 1x1 PNG, since every photo is now decoded and re-encoded.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWMwTgsFAAG+AO/TH36BAAAAAElFTkSuQmCC", "base64");

beforeEach(() => {
  queries = [];
  storageCalls = [];
  stagedBytes = null;
  respond = defaultRespond;
  ownRow = { id: PEN_ID, is_default: false, avatar_path: null };
  profileRole = "author";
  accountKind = "person";
  ownPenNameIds = [PEN_ID];
  profileWriteRows = [{ id: USER_ID }];
  resolveCalls = [];
  resolveResult = { ok: true, penNameId: NEW_ID };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updatePenName", () => {
  it("writes name, bio and links with the SESSION client, filtered by id and the session author", async () => {
    const target = await redirectOf(
      updatePenName(PEN_ID, form({ name: "  Jo Pen ", bio: " Bio ", links: ["https://a.example", "", ""] })),
    );
    expect(target).toBe("/dashboard/profile?success=Pseudonimi u ruajt.");
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
    ).toContain("deri në 3 lidhje");
    expect(queries.some((q) => method(q, "update"))).toBe(false);
  });

  it("a name another of the author's pen names uses (23505) gets the clear message", async () => {
    respond = (q) =>
      q.client === "session" && method(q, "update") ? { data: null, error: { code: "23505" } } : defaultRespond(q);
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Taken" })))).toBe(
      "/dashboard/profile?error=Këtë emër e përdorni tashmë si një nga pseudonimet tuaja. Zgjidhni një emër tjetër, ose ndryshoni më parë emrin e atij pseudonimi.",
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
      "/dashboard/profile?success=Pseudonimi u ruajt.",
    );
    const upload = storageCalls.find((c) => c.op === "upload")!;
    expect(upload.client).toBe("writer");
    expect(upload.bucket).toBe("avatars");
    // COVERS-1: stored as the shrunk JPEG.
    expect(upload.path).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/pen-name\.jpg$/);
    expect(upload.path).not.toContain(USER_ID);
    expect([...upload.bytes!.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(upload.opts).toEqual({ contentType: "image/jpeg", cacheControl: "604800", upsert: false });
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
    expect(target).toContain("nuk është më e vlefshme");
    expect(storageCalls).toEqual([]);
  });

  it("bytes that are not a JPEG or PNG are refused", async () => {
    stagedBytes = Buffer.from("not an image at all");
    const target = await redirectOf(
      updatePenName(PEN_ID, form({ name: "Jo", avatarStoragePath: `${USER_ID}/tmp/avatar/x.png` })),
    );
    expect(target).toContain("i vlefshëm JPEG ose PNG");
    expect(storageCalls.some((c) => c.op === "upload")).toBe(false);
  });

  // COVERS-1: a PNG signature followed by bytes that don't decode can't
  // be shrunk -- refused with the existing read error, never stored raw.
  it("a signature-valid photo that can't be decoded is refused", async () => {
    stagedBytes = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(512, 7)]);
    const target = await redirectOf(
      updatePenName(PEN_ID, form({ name: "Jo", avatarStoragePath: `${USER_ID}/tmp/avatar/x.png` })),
    );
    expect(target).toContain("Fotoja e ngarkuar nuk u lexua dot. Provoni përsëri.");
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
    ).toBe("/dashboard/profile?success=Profili u ruajt.");
    const removedAvatars = storageCalls.filter((c) => c.bucket === "avatars" && c.op === "remove");
    expect(removedAvatars).toEqual([]);
    const write = queries.find((q) => q.client === "writer" && method(q, "update"))!;
    expect((method(write, "update")!.args[0] as { avatar_path: string }).avatar_path).toMatch(/\/pen-name\.jpg$/);
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
    expect(await redirectOf(deletePenName(PEN_ID))).toBe("/dashboard/profile?success=Pseudonimi u fshi.");
    const del = queries.find((q) => q.client === "writer" && method(q, "delete"))!;
    expect(del.ops).toContainEqual({ method: "eq", args: ["id", PEN_ID] });
    expect(del.ops).toContainEqual({ method: "eq", args: ["author_id", USER_ID] });
    expect(del.ops).toContainEqual({ method: "eq", args: ["is_default", false] });
  });

  it("the default pen name is never deleted", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    expect(await redirectOf(deletePenName(PEN_ID))).toContain("Pseudonimi kryesor nuk mund të fshihet");
    expect(queries.some((q) => method(q, "delete"))).toBe(false);
  });

  it("a pen name used by a book, series or bundle is not deleted", async () => {
    respond = (q) => (q.table === "series" ? { count: 1 } : defaultRespond(q));
    expect(await redirectOf(deletePenName(PEN_ID))).toContain("përdoret ende");
    expect(queries.some((q) => method(q, "delete"))).toBe(false);
  });

  it("a foreign-key refusal (used after all) gets the same message", async () => {
    respond = (q) => (method(q, "delete") ? { data: null, error: { code: "23503" } } : defaultRespond(q));
    expect(await redirectOf(deletePenName(PEN_ID))).toContain("përdoret ende");
  });

  it("its photo is removed after the delete", async () => {
    ownRow = { id: PEN_ID, is_default: false, avatar_path: OLD_PHOTO };
    await redirectOf(deletePenName(PEN_ID));
    expect(storageCalls).toEqual([{ client: "writer", bucket: "avatars", op: "remove", path: [OLD_PHOTO] }]);
  });
});

// AUTHOR PROFILI (build 1, Q1 b): the main card's Ruani also saves the
// account name, which only the default pen name's form carries.
describe("updatePenName: the account name on the main card", () => {
  it("default card: writes display_name (session client, own row) first, then the pen name", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    const target = await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", displayName: "  Ana Test " })));
    expect(target).toBe("/dashboard/profile?success=Profili u ruajt.");
    const profileWrite = queries.findIndex((q) => q.table === "profiles" && method(q, "update"));
    const penWrite = queries.findIndex((q) => q.table === "pen_names" && method(q, "update"));
    expect(profileWrite).toBeGreaterThan(-1);
    expect(profileWrite).toBeLessThan(penWrite);
    const q = queries[profileWrite];
    expect(q.client).toBe("session");
    expect(method(q, "update")!.args[0]).toEqual({ display_name: "Ana Test" });
    expect(q.ops).toContainEqual({ method: "eq", args: ["id", USER_ID] });
  });

  it("a blank or too long account name is refused before any write", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", displayName: "  " })))).toBe(
      "/dashboard/profile?error=Emri nuk mund të jetë bosh",
    );
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", displayName: "x".repeat(121) })))).toBe(
      "/dashboard/profile?error=Emri mund të ketë deri në 120 karaktere",
    );
    expect(queries.some((q) => method(q, "update"))).toBe(false);
  });

  it("a bad pen name field stops the save before the account name is written", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    await redirectOf(updatePenName(PEN_ID, form({ name: " ", displayName: "Ana" })));
    expect(queries.some((q) => method(q, "update"))).toBe(false);
  });

  it("an account name write that doesn't return exactly the own row fails; the pen name is not written", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    profileWriteRows = [];
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", displayName: "Ana" })))).toBe(
      "/dashboard/profile?error=Profili nuk u ruajt dot. Provoni përsëri.",
    );
    expect(queries.some((q) => q.table === "pen_names" && method(q, "update"))).toBe(false);
  });

  it("another pen name's form never writes the account name, even if the field is sent", async () => {
    await redirectOf(updatePenName(PEN_ID, form({ name: "Jo", displayName: "Ana" })));
    expect(queries.some((q) => q.table === "profiles")).toBe(false);
  });
});

// AUTHOR PROFILI (build 1, Q2 a / Q3 a): "+ Shto pseudonim".
describe("createPenName", () => {
  it("creates through resolveOwnPenNameId with the session author and the trimmed name", async () => {
    expect(await redirectOf(createPenName(form({ name: "  A. T. Hija " })))).toBe(
      "/dashboard/profile?success=Pseudonimi u shtua.",
    );
    expect(resolveCalls).toEqual([[USER_ID, "A. T. Hija"]]);
  });

  it("an empty name is refused before anything is created", async () => {
    expect(await redirectOf(createPenName(form({ name: "  " })))).toBe(
      "/dashboard/profile?error=Pseudonimi nuk mund të jetë bosh.",
    );
    expect(resolveCalls).toEqual([]);
  });

  it("a name the author already uses gives the clear message, and no new pen name", async () => {
    resolveResult = { ok: true, penNameId: PEN_ID };
    expect(await redirectOf(createPenName(form({ name: "jo pen" })))).toBe(
      "/dashboard/profile?error=Këtë emër e përdorni tashmë si një nga pseudonimet tuaja. Zgjidhni një emër tjetër, ose ndryshoni më parë emrin e atij pseudonimi.",
    );
  });

  it("a reader (not an author) is refused before anything is created", async () => {
    profileRole = "reader";
    expect(await redirectOf(createPenName(form({ name: "Jo" })))).toBe(
      "/dashboard/profile?error=Pseudonimi nuk u shtua dot. Provoni përsëri.",
    );
    expect(resolveCalls).toEqual([]);
  });

  it("a failed create gives the generic message", async () => {
    resolveResult = { ok: false, reason: "failed" };
    expect(await redirectOf(createPenName(form({ name: "Jo" })))).toBe(
      "/dashboard/profile?error=Pseudonimi nuk u shtua dot. Provoni përsëri.",
    );
  });
});

// BUILD 2a-2: a publishing house's Autorët tab sends from=authors; the
// same actions then come back to Autorët and say "autor". The field only
// picks the page and the words; the writes are the same.
describe("from=authors (a publishing house's Autorët tab)", () => {
  const AUTHORS = { from: "authors" };

  it("save: back to Autorët with 'Autori u ruajt.', same session write", async () => {
    expect(await redirectOf(updatePenName(PEN_ID, form({ ...AUTHORS, name: "Arta Test" })))).toBe(
      "/dashboard/authors?success=Autori u ruajt.",
    );
    const write = queries.find((q) => q.client === "session" && q.table === "pen_names" && method(q, "update"))!;
    expect(write.ops).toContainEqual({ method: "eq", args: ["author_id", USER_ID] });
  });

  it("add: back to Autorët with 'Autori u shtua.', through resolveOwnPenNameId", async () => {
    ownPenNameIds = [PEN_ID];
    expect(await redirectOf(createPenName(form({ ...AUTHORS, name: "Besnik Test" })))).toBe(
      "/dashboard/authors?success=Autori u shtua.",
    );
    expect(resolveCalls).toEqual([[USER_ID, "Besnik Test"]]);
  });

  it("remove: back to Autorët with 'Autori u hoq.'", async () => {
    expect(await redirectOf(deletePenName(PEN_ID, form(AUTHORS)))).toBe("/dashboard/authors?success=Autori u hoq.");
  });

  it("errors use author words on Autorët", async () => {
    expect(await redirectOf(createPenName(form({ ...AUTHORS, name: "  " })))).toBe(
      "/dashboard/authors?error=Emri i autorit nuk mund të jetë bosh.",
    );
    resolveResult = { ok: true, penNameId: PEN_ID };
    expect(await redirectOf(createPenName(form({ ...AUTHORS, name: "Arta" })))).toBe(
      "/dashboard/authors?error=Këtë emër e ka tashmë një nga autorët tuaj ose shtëpia juaj botuese. Zgjidhni një emër tjetër.",
    );
    respond = (q) => (q.table === "books" ? { count: 2 } : defaultRespond(q));
    expect(await redirectOf(deletePenName(PEN_ID, form(AUTHORS)))).toBe(
      "/dashboard/authors?error=Ky autor ka ende një libër, seri ose paketë, ndaj nuk mund të hiqet.",
    );
    expect(await redirectOf(updatePenName("../x", form({ ...AUTHORS, name: "Jo" })))).toBe(
      "/dashboard/authors?error=Autori nuk u ruajt dot. Provoni përsëri.",
    );
  });

  it("a message with no author version is passed through as it is", async () => {
    expect(await redirectOf(updatePenName(PEN_ID, form({ ...AUTHORS, name: "Jo", links: ["http://a.example"] })))).toMatch(
      /^\/dashboard\/authors\?error=.*https:\/\//,
    );
  });

  it("any other 'from' value keeps Profili and pseudonym words", async () => {
    expect(await redirectOf(updatePenName(PEN_ID, form({ from: "x", name: "Jo" })))).toBe(
      "/dashboard/profile?success=Pseudonimi u ruajt.",
    );
    expect(await redirectOf(deletePenName(PEN_ID))).toBe("/dashboard/profile?success=Pseudonimi u fshi.");
  });
});

// BUILD 2a-2 (Renato's k2 a): saving a house's own card also saves the
// house name as the account name (the house Profili has no account name
// field). A person author's main card without the field writes nothing
// to the profile.
describe("updatePenName: a publishing house's own card (k2 a)", () => {
  it("writes the house name as display_name first (own row, session client), then the pen name", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    accountKind = "publishing_house";
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "  Botime Reja " })))).toBe(
      "/dashboard/profile?success=Profili u ruajt.",
    );
    const read = queries.find((q) => q.table === "profiles" && !method(q, "update"))!;
    expect(method(read, "select")!.args[0]).toBe("account_kind");
    expect(read.ops).toContainEqual({ method: "eq", args: ["id", USER_ID] });
    const profileWrite = queries.findIndex((q) => q.table === "profiles" && method(q, "update"));
    const penWrite = queries.findIndex((q) => q.table === "pen_names" && method(q, "update"));
    expect(profileWrite).toBeGreaterThan(-1);
    expect(profileWrite).toBeLessThan(penWrite);
    expect(queries[profileWrite].client).toBe("session");
    expect(method(queries[profileWrite], "update")!.args[0]).toEqual({ display_name: "Botime Reja" });
    expect(queries[profileWrite].ops).toContainEqual({ method: "eq", args: ["id", USER_ID] });
  });

  it("a person author's main card without the field leaves the account name alone", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    await redirectOf(updatePenName(PEN_ID, form({ name: "Jo" })));
    expect(queries.some((q) => q.table === "profiles" && method(q, "update"))).toBe(false);
  });

  it("a house's author card (not the default) never writes the account name", async () => {
    accountKind = "publishing_house";
    await redirectOf(updatePenName(PEN_ID, form({ from: "authors", name: "Arta" })));
    expect(queries.some((q) => q.table === "profiles")).toBe(false);
  });

  it("the kind can't be read: nothing is written", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    respond = (q) => (q.table === "profiles" && !method(q, "update") ? { data: null, error: { code: "XX" } } : defaultRespond(q));
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Jo" })))).toBe(
      "/dashboard/profile?error=Profili nuk u ruajt dot. Provoni përsëri.",
    );
    expect(queries.some((q) => method(q, "update"))).toBe(false);
  });

  it("an account name write that fails stops the save; the pen name is not written", async () => {
    ownRow = { id: PEN_ID, is_default: true, avatar_path: null };
    accountKind = "publishing_house";
    profileWriteRows = [];
    expect(await redirectOf(updatePenName(PEN_ID, form({ name: "Botime" })))).toBe(
      "/dashboard/profile?error=Profili nuk u ruajt dot. Provoni përsëri.",
    );
    expect(queries.some((q) => q.table === "pen_names" && method(q, "update"))).toBe(false);
  });
});
