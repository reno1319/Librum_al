import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import {
  BOOK_FIXTURE_AUTHOR_ID as USER_ID,
  BOOK_FIXTURE_BOOK_ID as BOOK_ID,
  BOOK_FIXTURE_OTHER_AUTHOR_ID as OTHER_ID,
  BOOK_FIXTURE_OTHER_BOOK_ID as OTHER_BOOK_ID,
  UNSAFE_COVER_PATHS,
  UNSAFE_MANUSCRIPT_PATHS,
} from "@/lib/book-storage-path-test-fixtures";

// ACCOUNT-DELETION-BOOK-STORAGE-AUTH-1 (Patch 10): the REAL deleteAccount
// Server Action hands a stored books.cover_path / books.file_path to
// service-role Storage removal ONLY when it is exactly the deleting
// user's own canonical key for THAT row's book id. Everything else is
// skipped (never removed, never logged) while the account deletion and
// every other safe cleanup go ahead. A failed or ambiguous books read
// stops before anything irreversible.
//
// Storage is simulated as a set of objects per bucket, including the
// other author's objects; every test ends by checking that none of the
// other author's objects was removed and that no removal was attempted
// through anything but the expected bucket and exact array.

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
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }));

const cookieStore = { get: vi.fn((_name: string) => undefined as { value: string } | undefined) };
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(cookieStore) }));

type Book = { id: unknown; cover_path: unknown; file_path: unknown };
type StorageCall = { via: "session" | "service"; bucket: string; paths: unknown };

let authUser: { id: string } | null;
let staffResult: { data: unknown; error: unknown };
let profileResult: { data: unknown; error: unknown };
let booksResult: { data: unknown; error: unknown };
let purchaseCount: number;
let purchaseBookIds: unknown[] | null;
let deleteUserError: unknown;
let storageCalls: StorageCall[];
let events: string[];
let adminClientsCreated: number;
let signOut: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let failingRemoveBuckets: Set<string>;
let objects: Record<string, Set<string>>;

const OWN_COVER = `${USER_ID}/${BOOK_ID}-cover.png`;
const OWN_MANUSCRIPT = `${USER_ID}/${BOOK_ID}.epub`;
const OWN_BOOK_2_COVER = `${USER_ID}/${OTHER_BOOK_ID}-cover.jpg`;
const OWN_BOOK_2_MANUSCRIPT = `${USER_ID}/${OTHER_BOOK_ID}.epub`;
const VICTIM_COVER = `${OTHER_ID}/${OTHER_BOOK_ID}-cover.png`;
const VICTIM_MANUSCRIPT = `${OTHER_ID}/${OTHER_BOOK_ID}.epub`;
const VICTIM_OBJECTS = {
  covers: [VICTIM_COVER, `${OTHER_ID}/${BOOK_ID}-cover.png`, `${OTHER_ID}/${OTHER_BOOK_ID}-cover.jpg`],
  manuscripts: [VICTIM_MANUSCRIPT, `${OTHER_ID}/${BOOK_ID}.epub`],
  avatars: [`${OTHER_ID}/avatar.png`],
};

function setBooks(rows: Book[]) {
  booksResult = { data: rows, error: null };
}

function sessionFrom(table: string) {
  if (table === "staff_members") {
    return { select: () => ({ eq: () => ({ maybeSingle: async () => { events.push("read:staff"); return staffResult; } }) }) };
  }
  if (table === "profiles") {
    return { select: () => ({ eq: () => ({ maybeSingle: async () => { events.push("read:profile"); return profileResult; } }) }) };
  }
  if (table === "books") {
    return {
      select: (columns: string) => ({
        eq: (column: string, value: unknown) => ({
          returns: async () => {
            events.push(`read:books:${columns}:${column}=${String(value)}`);
            return booksResult;
          },
        }),
      }),
    };
  }
  if (table === "purchases") {
    return {
      select: () => ({
        in: async (_column: string, ids: unknown[]) => {
          events.push("read:purchases");
          purchaseBookIds = ids;
          return { count: purchaseCount, error: null };
        },
      }),
    };
  }
  throw new Error(`unexpected table ${table}`);
}

function storage(via: "session" | "service") {
  return {
    from: (bucket: string) => ({
      remove: async (paths: unknown) => {
        storageCalls.push({ via, bucket, paths });
        events.push(`remove:${bucket}`);
        if (failingRemoveBuckets.has(bucket)) return { data: null, error: { message: "storage down" } };
        for (const p of paths as string[]) objects[bucket]?.delete(p);
        return { data: [], error: null };
      },
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: authUser } }),
      signOut: (...a: unknown[]) => {
        events.push("signOut");
        return signOut(...a);
      },
    },
    from: sessionFrom,
    storage: storage("session"),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminClientsCreated += 1;
    events.push("admin:create");
    return {
      auth: {
        admin: {
          deleteUser: async (id: string) => {
            events.push(`deleteUser:${id}`);
            return { error: deleteUserError };
          },
        },
      },
      storage: storage("service"),
    };
  },
}));

const { deleteAccount } = await import("./actions");

async function run(extra: Record<string, string> = {}, confirmation = "DELETE"): Promise<string> {
  const fd = new FormData();
  fd.set("confirmation", confirmation);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  try {
    await deleteAccount(fd);
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error("deleteAccount returned without redirecting");
}

const removalsFor = (bucket: string) => storageCalls.filter((c) => c.bucket === bucket);
const allLogCalls = () =>
  (["error", "warn", "log", "info", "debug"] as const).flatMap((m) => vi.mocked(console[m]).mock.calls);
const COVER_WARNING =
  "deleteAccount: stored book cover_path values that are not this user's canonical keys were skipped; count:";
const MANUSCRIPT_WARNING =
  "deleteAccount: stored book file_path values that are not this user's canonical keys were skipped; count:";
const PREPARE_ERROR = "/account?error=Unable+to+prepare+account+deletion.+Try+again.";

function expectNothingIrreversible() {
  expect(adminClientsCreated).toBe(0);
  expect(events.some((e) => e.startsWith("deleteUser"))).toBe(false);
  expect(storageCalls).toEqual([]);
  expect(signOut).not.toHaveBeenCalled();
  expect(revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  authUser = { id: USER_ID };
  staffResult = { data: null, error: null };
  profileResult = { data: { avatar_path: null }, error: null };
  booksResult = { data: [], error: null };
  purchaseCount = 0;
  purchaseBookIds = null;
  deleteUserError = null;
  storageCalls = [];
  events = [];
  adminClientsCreated = 0;
  signOut = vi.fn();
  revalidatePath.mockReset();
  failingRemoveBuckets = new Set();
  objects = {
    covers: new Set([OWN_COVER, OWN_BOOK_2_COVER, ...VICTIM_OBJECTS.covers]),
    manuscripts: new Set([OWN_MANUSCRIPT, OWN_BOOK_2_MANUSCRIPT, ...VICTIM_OBJECTS.manuscripts]),
    avatars: new Set([`${USER_ID}/avatar.png`, ...VICTIM_OBJECTS.avatars]),
  };
  cookieStore.get.mockReset().mockImplementation(() => undefined);
  for (const m of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(() => {});
});

afterEach(() => {
  // 19: the other author's objects are untouched in every case, and no
  // removal ever ran through the session client or an unexpected bucket.
  for (const [bucket, names] of Object.entries(VICTIM_OBJECTS)) {
    for (const name of names) expect(objects[bucket].has(name)).toBe(true);
  }
  for (const call of storageCalls) {
    expect(call.via).toBe("service");
    expect(["covers", "manuscripts", "avatars"]).toContain(call.bucket);
    expect(JSON.stringify(call.paths)).not.toContain(OTHER_ID);
  }
  vi.restoreAllMocks();
});

describe("books read fails closed (1, 2)", () => {
  it("a books-read database error stops before admin-client creation", async () => {
    booksResult = { data: null, error: { message: "db down", code: "57014" } };
    expect(await run()).toBe(PREPARE_ERROR);
    expectNothingIrreversible();
    expect(events).not.toContain("read:purchases");
  });

  it("an error accompanied by plausible, canonical rows also stops", async () => {
    booksResult = { data: [{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }], error: { message: "partial" } };
    expect(await run()).toBe(PREPARE_ERROR);
    expectNothingIrreversible();
  });

  it("an error accompanied by an empty list also stops", async () => {
    booksResult = { data: [], error: { message: "partial" } };
    expect(await run()).toBe(PREPARE_ERROR);
    expectNothingIrreversible();
  });

  it.each([
    ["null data, no error", null],
    ["undefined data, no error", undefined],
    ["a single object instead of a list", { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }],
    ["a string", "[]"],
  ])("a non-list result (%s) is not 'no books': it stops", async (_label, data) => {
    booksResult = { data, error: null };
    expect(await run()).toBe(PREPARE_ERROR);
    expectNothingIrreversible();
  });

  it("logs only a stable diagnostic, never the error payload or any stored path", async () => {
    booksResult = { data: [{ id: BOOK_ID, cover_path: VICTIM_COVER, file_path: VICTIM_MANUSCRIPT }], error: { message: `boom ${VICTIM_COVER}` } };
    expect(await run()).toBe(PREPARE_ERROR);
    expect(allLogCalls()).toEqual([["deleteAccount: authored books read failed; nothing was deleted"]]);
  });

  it("reads exactly this user's authored books", async () => {
    await run();
    expect(events).toContain(`read:books:id, cover_path, file_path:author_id=${USER_ID}`);
  });
});

describe("successful reads", () => {
  it("3: a successful empty result still permits ordinary deletion, with no book removal", async () => {
    setBooks([]);
    expect(await run()).toBe("/?account=deleted");
    expect(events).toContain(`deleteUser:${USER_ID}`);
    expect(removalsFor("covers")).toEqual([]);
    expect(removalsFor("manuscripts")).toEqual([]);
    expect(events).not.toContain("read:purchases");
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("4, 21: exact canonical own cover and manuscript are removed, only after deleteUser, through the service role with the exact bucket and array", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] },
    ]);
    const del = events.indexOf(`deleteUser:${USER_ID}`);
    expect(del).toBeGreaterThan(-1);
    expect(del).toBeLessThan(events.indexOf("remove:covers"));
    expect(del).toBeLessThan(events.indexOf("remove:manuscripts"));
    expect(objects.covers.has(OWN_COVER)).toBe(false);
    expect(objects.manuscripts.has(OWN_MANUSCRIPT)).toBe(false);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("a canonical .jpg cover is removed too", async () => {
    setBooks([{ id: OTHER_BOOK_ID, cover_path: OWN_BOOK_2_COVER, file_path: null }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([{ via: "service", bucket: "covers", paths: [OWN_BOOK_2_COVER] }]);
  });

  it("several books: every safe object of each bucket goes in one call, in row order", async () => {
    setBooks([
      { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT },
      { id: OTHER_BOOK_ID, cover_path: OWN_BOOK_2_COVER, file_path: OWN_BOOK_2_MANUSCRIPT },
    ]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER, OWN_BOOK_2_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT, OWN_BOOK_2_MANUSCRIPT] },
    ]);
  });

  it("10: null paths create no removal call and no warning", async () => {
    setBooks([{ id: BOOK_ID, cover_path: null, file_path: null }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
    expect(events).toContain(`deleteUser:${USER_ID}`);
  });

  it("20: duplicate safe paths are sent at most once", async () => {
    setBooks([
      { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT },
      { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT },
    ]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] },
    ]);
  });
});

describe("foreign canonical keys are skipped (5-8)", () => {
  it("5: another author's canonical cover is skipped", async () => {
    setBooks([{ id: OTHER_BOOK_ID, cover_path: VICTIM_COVER, file_path: null }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
    expect(allLogCalls()).toEqual([[COVER_WARNING, 1]]);
  });

  it("6: another author's canonical manuscript is skipped", async () => {
    setBooks([{ id: OTHER_BOOK_ID, cover_path: null, file_path: VICTIM_MANUSCRIPT }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
    expect(allLogCalls()).toEqual([[MANUSCRIPT_WARNING, 1]]);
  });

  it("another author's key for this very book id is skipped", async () => {
    setBooks([{ id: BOOK_ID, cover_path: `${OTHER_ID}/${BOOK_ID}-cover.png`, file_path: `${OTHER_ID}/${BOOK_ID}.epub` }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
  });

  it("7: another book's canonical cover (own author prefix) is skipped", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_BOOK_2_COVER, file_path: null }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
    expect(objects.covers.has(OWN_BOOK_2_COVER)).toBe(true);
  });

  it("8: another book's canonical manuscript (own author prefix) is skipped", async () => {
    setBooks([{ id: BOOK_ID, cover_path: null, file_path: OWN_BOOK_2_MANUSCRIPT }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
    expect(objects.manuscripts.has(OWN_BOOK_2_MANUSCRIPT)).toBe(true);
  });

  it("the row's book id must be a lowercase UUID: a malformed id makes both keys unsafe", async () => {
    for (const id of [BOOK_ID.toUpperCase(), "book-1", null, 7]) {
      storageCalls = [];
      setBooks([{ id, cover_path: `${USER_ID}/${String(id)}-cover.png`, file_path: `${USER_ID}/${String(id)}.epub` }]);
      expect(await run()).toBe("/?account=deleted");
      expect(storageCalls).toEqual([]);
    }
  });

  it("identity comes only from the session: client-supplied author/book/path fields change nothing", async () => {
    setBooks([{ id: OTHER_BOOK_ID, cover_path: VICTIM_COVER, file_path: VICTIM_MANUSCRIPT }]);
    expect(
      await run({
        userId: OTHER_ID,
        user_id: OTHER_ID,
        authorId: OTHER_ID,
        author_id: OTHER_ID,
        bookId: OTHER_BOOK_ID,
        cover_path: VICTIM_COVER,
        file_path: VICTIM_MANUSCRIPT,
        bucket: "covers",
      }),
    ).toBe("/?account=deleted");
    expect(storageCalls).toEqual([]);
    expect(events.filter((e) => e.startsWith("read:books"))).toEqual([
      `read:books:id, cover_path, file_path:author_id=${USER_ID}`,
    ]);
    expect(events.filter((e) => e.startsWith("deleteUser"))).toEqual([`deleteUser:${USER_ID}`]);
  });
});

describe("9, 12, 22: every hostile path class is skipped, never reaches remove, never logged", () => {
  function expectNotLogged(value: unknown) {
    const logged = JSON.stringify(allLogCalls());
    expect(logged).not.toContain(OTHER_ID);
    expect(logged).not.toContain(OTHER_BOOK_ID);
    if (typeof value === "string" && value.trim().length >= 8) {
      expect(logged).not.toContain(JSON.stringify(value).slice(1, -1));
    }
  }

  it.each(UNSAFE_COVER_PATHS)("cover: %s", async (_label, value) => {
    setBooks([{ id: BOOK_ID, cover_path: value, file_path: OWN_MANUSCRIPT }]);
    expect(await run()).toBe("/?account=deleted");
    // Only the safe manuscript is removed; no cover removal at all.
    expect(storageCalls).toEqual([{ via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] }]);
    expect(allLogCalls()).toEqual([[COVER_WARNING, 1]]);
    expectNotLogged(value);
    expect(objects.covers.has(OWN_COVER)).toBe(true);
  });

  it.each(UNSAFE_MANUSCRIPT_PATHS)("manuscript: %s", async (_label, value) => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: value }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([{ via: "service", bucket: "covers", paths: [OWN_COVER] }]);
    expect(allLogCalls()).toEqual([[MANUSCRIPT_WARNING, 1]]);
    expectNotLogged(value);
    expect(objects.manuscripts.has(OWN_MANUSCRIPT)).toBe(true);
  });

  it("the whole hostile corpus at once, mixed with safe rows: only the safe values reach remove", async () => {
    const rows: Book[] = [
      { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT },
      ...UNSAFE_COVER_PATHS.map(([, v]) => ({ id: BOOK_ID, cover_path: v, file_path: null })),
      ...UNSAFE_MANUSCRIPT_PATHS.map(([, v]) => ({ id: BOOK_ID, cover_path: null, file_path: v })),
      { id: OTHER_BOOK_ID, cover_path: OWN_BOOK_2_COVER, file_path: OWN_BOOK_2_MANUSCRIPT },
    ];
    setBooks(rows);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER, OWN_BOOK_2_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT, OWN_BOOK_2_MANUSCRIPT] },
    ]);
    expect(allLogCalls()).toEqual([
      [COVER_WARNING, UNSAFE_COVER_PATHS.length],
      [MANUSCRIPT_WARNING, UNSAFE_MANUSCRIPT_PATHS.length],
    ]);
    expectNotLogged(null);
  });
});

describe("11: mixed safe/unsafe rows remove only the safe values, bucket by bucket", () => {
  it("an unsafe cover does not suppress the same row's safe manuscript", async () => {
    setBooks([{ id: BOOK_ID, cover_path: VICTIM_COVER, file_path: OWN_MANUSCRIPT }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([{ via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] }]);
  });

  it("an unsafe manuscript does not suppress the same row's safe cover", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: VICTIM_MANUSCRIPT }]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([{ via: "service", bucket: "covers", paths: [OWN_COVER] }]);
  });

  it("an unsafe row does not suppress another row's safe objects", async () => {
    setBooks([
      { id: OTHER_BOOK_ID, cover_path: VICTIM_COVER, file_path: VICTIM_MANUSCRIPT },
      { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT },
    ]);
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] },
    ]);
    expect(allLogCalls()).toEqual([[COVER_WARNING, 1], [MANUSCRIPT_WARNING, 1]]);
  });
});

describe("destructive ordering (13-16)", () => {
  it("13: a failed deleteUser causes zero Storage-removal calls, even with safe paths and avatar", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    deleteUserError = { message: "restrict violation" };
    expect(await run()).toBe("/account?error=Something+went+wrong+deleting+your+account.+Please+try+again");
    expect(storageCalls).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("14: a cover-removal failure does not prevent manuscript and avatar cleanup", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    failingRemoveBuckets.add("covers");
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls.map((c) => c.bucket)).toEqual(["covers", "manuscripts", "avatars"]);
    expect(console.error).toHaveBeenCalledWith("deleteAccount: failed to remove orphaned cover files:", { message: "storage down" });
    expect(objects.manuscripts.has(OWN_MANUSCRIPT)).toBe(false);
    expect(objects.avatars.has(`${USER_ID}/avatar.png`)).toBe(false);
  });

  it("15: a manuscript-removal failure triggers no retry, no rollback and no further privileged call", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    failingRemoveBuckets.add("manuscripts");
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] },
    ]);
    expect(adminClientsCreated).toBe(1);
    expect(events.filter((e) => e.startsWith("deleteUser"))).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("deleteAccount: failed to remove orphaned manuscript files:", { message: "storage down" });
  });

  it("16: avatar cleanup is unchanged: canonical avatar removed last, alone, in its own bucket", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(storageCalls).toEqual([
      { via: "service", bucket: "covers", paths: [OWN_COVER] },
      { via: "service", bucket: "manuscripts", paths: [OWN_MANUSCRIPT] },
      { via: "service", bucket: "avatars", paths: [`${USER_ID}/avatar.png`] },
    ]);
  });

  it("16: an unsafe avatar is still skipped with its own warning, independently of books", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    profileResult = { data: { avatar_path: `${OTHER_ID}/avatar.png` }, error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(removalsFor("avatars")).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
      "deleteAccount: stored avatar_path is not this user's canonical avatar key; avatar cleanup skipped",
    );
  });

  it("the full irreversible sequence is: reads, then admin client, then deleteUser, then removals, then sign-out", async () => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(events).toEqual([
      "read:staff",
      "read:profile",
      `read:books:id, cover_path, file_path:author_id=${USER_ID}`,
      "read:purchases",
      "admin:create",
      `deleteUser:${USER_ID}`,
      "remove:covers",
      "remove:manuscripts",
      "remove:avatars",
      "signOut",
    ]);
    expect(revalidatePath).toHaveBeenCalledWith("/", "layout");
  });
});

describe("17, 18: existing gates stay ahead of the books read", () => {
  beforeEach(() => {
    setBooks([{ id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT }]);
  });

  it("recovery session: /reset-password, nothing read", async () => {
    cookieStore.get.mockImplementation((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined));
    expect(await run()).toContain("/reset-password");
    expect(events).toEqual([]);
    expectNothingIrreversible();
  });

  it("unauthenticated: /login, nothing read", async () => {
    authUser = null;
    expect(await run()).toBe("/login");
    expect(events).toEqual([]);
    expectNothingIrreversible();
  });

  it("active staff: blocked before the books read", async () => {
    staffResult = { data: { role: "owner" }, error: null };
    expect(await run()).toBe("/account?error=Remove+this+account+from+Librum+staff+before+deleting+the+account.");
    expect(events).toEqual(["read:staff"]);
    expectNothingIrreversible();
  });

  it("staff lookup error: blocked before the books read", async () => {
    staffResult = { data: null, error: { message: "x" } };
    expect(await run()).toBe("/account?error=Unable+to+verify+account+eligibility+for+deletion.+Try+again.");
    expect(events).toEqual(["read:staff"]);
    expectNothingIrreversible();
  });

  it.each(["", "delete", "DELETE ", "Delete"])("wrong confirmation %j: blocked before the books read", async (confirmation) => {
    expect(await run({}, confirmation)).toBe("/account?error=Type+DELETE+to+confirm");
    expect(events).toEqual(["read:staff"]);
    expectNothingIrreversible();
  });

  it("profile read error: blocked before the books read", async () => {
    profileResult = { data: null, error: { message: "x" } };
    expect(await run()).toBe(PREPARE_ERROR);
    expect(events).toEqual(["read:staff", "read:profile"]);
    expectNothingIrreversible();
  });

  it("18: acquisition history still blocks, checked over this user's book ids, before any privileged call", async () => {
    purchaseCount = 1;
    expect(await run()).toContain("/account?error=Your+account+can%27t+be+deleted");
    expect(purchaseBookIds).toEqual([BOOK_ID]);
    expectNothingIrreversible();
  });

  it("18: the acquisition check covers every authored book, including rows whose paths are unsafe", async () => {
    setBooks([
      { id: BOOK_ID, cover_path: OWN_COVER, file_path: OWN_MANUSCRIPT },
      { id: OTHER_BOOK_ID, cover_path: VICTIM_COVER, file_path: VICTIM_MANUSCRIPT },
    ]);
    purchaseCount = 2;
    expect(await run()).toContain("/account?error=Your+account+can%27t+be+deleted");
    expect(purchaseBookIds).toEqual([BOOK_ID, OTHER_BOOK_ID]);
    expectNothingIrreversible();
  });
});
