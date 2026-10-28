import { beforeEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import {
  AVATAR_FIXTURE_OTHER_ID as OTHER_ID,
  AVATAR_FIXTURE_USER_ID as USER_ID,
  UNSAFE_AVATAR_PATHS_FOR_USER,
} from "@/lib/avatar-path-test-fixtures";

// AVATAR-STORAGE-PATH-AUTH-1 (Patch 9): deleteAccount hands a stored
// avatar_path to service-role Storage removal ONLY when it is exactly the
// deleting user's own canonical avatar key. Every other value produces
// zero privileged avatar removals while the account deletion itself goes
// ahead; a failed profile read stops before anything irreversible.
//
// Every Storage call is recorded per client AND per bucket, so an avatar
// assertion can never pass because a cover or manuscript removal happened
// (or failed to), and vice versa. Book/cover/manuscript cleanup is NOT
// changed by this patch (see F3 in the Patch 9 report): the suite pins
// that it still happens exactly as before, alongside the avatar decision.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
// ADMIN-3-REVIEW: book_reviews reads/writes replaced by a settable
// double (default: nothing pending, approval valid); see
// src/lib/book-reviews-test-double.ts.
vi.mock("@/lib/book-reviews", async (importOriginal) => {
  const { bookReviewsDouble } = await import("@/lib/book-reviews-test-double");
  return bookReviewsDouble(await importOriginal<object>());
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const cookieStore = { get: vi.fn((_name: string) => undefined as { value: string } | undefined) };
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(cookieStore) }));

type Book = { id: string; cover_path: string | null; file_path: string | null };
type StorageCall = { via: "session" | "service"; bucket: string; op: string; paths: unknown };

let authUser: { id: string } | null;
let staffResult: { data: unknown; error: unknown };
let profileResult: { data: unknown; error: unknown };
let books: Book[];
let purchaseCount: number;
let deleteUserError: unknown;
let storageCalls: StorageCall[];
let events: string[];
let adminClientsCreated: number;
let signOut: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
let failingRemoveBucket: string | null;
let penNamesResult: { data: unknown; error: unknown };

function sessionFrom(table: string) {
  if (table === "staff_members") {
    return { select: () => ({ eq: () => ({ maybeSingle: async () => { events.push("read:staff"); return staffResult; } }) }) };
  }
  if (table === "profiles") {
    const terminal = async () => {
      events.push("read:profile");
      return profileResult;
    };
    return { select: () => ({ eq: () => ({ maybeSingle: terminal, single: terminal }) }) };
  }
  if (table === "books") {
    return {
      select: () => ({
        eq: () => ({
          returns: async () => {
            events.push("read:books");
            return { data: books, error: null };
          },
        }),
      }),
    };
  }
  // PEN-NAMES-1: the account's pen name photos.
  if (table === "pen_names") {
    return {
      select: () => ({
        eq: () => ({
          returns: async () => {
            events.push("read:pen_names");
            return penNamesResult;
          },
        }),
      }),
    };
  }
  if (table === "purchases" || table === "author_book_purchases") {
    return { select: () => ({ in: async () => ({ count: purchaseCount, error: null }) }) };
  }
  throw new Error(`unexpected table ${table}`);
}

function storage(via: "session" | "service") {
  return {
    from: (bucket: string) => ({
      remove: async (paths: unknown) => {
        storageCalls.push({ via, bucket, op: "remove", paths });
        events.push(`remove:${bucket}`);
        return { error: bucket === failingRemoveBucket ? { message: "storage down" } : null };
      },
    }),
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: authUser } }), signOut: (...a: unknown[]) => signOut(...a) },
    from: sessionFrom,
    storage: storage("session"),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    adminClientsCreated += 1;
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

async function run(confirmation = "FSHI"): Promise<string> {
  const fd = new FormData();
  fd.set("confirmation", confirmation);
  try {
    await deleteAccount(fd);
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  throw new Error("deleteAccount returned without redirecting");
}

const avatarRemovals = () => storageCalls.filter((c) => c.bucket === "avatars");
const nonAvatarRemovals = () => storageCalls.filter((c) => c.bucket !== "avatars");

const OWN_BOOK: Book = {
  id: "c0000000-0000-4000-8000-000000000001",
  cover_path: `${USER_ID}/c0000000-0000-4000-8000-000000000001-cover.png`,
  file_path: `${USER_ID}/c0000000-0000-4000-8000-000000000001.epub`,
};

beforeEach(() => {
  authUser = { id: USER_ID };
  staffResult = { data: null, error: null };
  profileResult = { data: { avatar_path: null }, error: null };
  books = [];
  purchaseCount = 0;
  deleteUserError = null;
  storageCalls = [];
  events = [];
  adminClientsCreated = 0;
  signOut = vi.fn();
  failingRemoveBucket = null;
  penNamesResult = { data: [], error: null };
  cookieStore.get.mockReset().mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("deleteAccount: valid canonical avatar", () => {
  it.each(["png", "jpg"])("removes exactly the user's own avatar.%s, once, from the avatars bucket, after deleteUser", async (ext) => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.${ext}` }, error: null };

    expect(await run()).toBe("/?account=deleted");

    expect(avatarRemovals()).toEqual([
      { via: "service", bucket: "avatars", op: "remove", paths: [`${USER_ID}/avatar.${ext}`] },
    ]);
    expect(nonAvatarRemovals()).toEqual([]);
    expect(events.indexOf(`deleteUser:${USER_ID}`)).toBeLessThan(events.indexOf("remove:avatars"));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("with authored books: the avatar removal is the avatar alone, and book cleanup is unchanged and separate", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    books = [OWN_BOOK];

    expect(await run()).toBe("/?account=deleted");

    expect(avatarRemovals()).toEqual([
      { via: "service", bucket: "avatars", op: "remove", paths: [`${USER_ID}/avatar.png`] },
    ]);
    expect(nonAvatarRemovals()).toEqual([
      { via: "service", bucket: "covers", op: "remove", paths: [OWN_BOOK.cover_path] },
      { via: "service", bucket: "manuscripts", op: "remove", paths: [OWN_BOOK.file_path] },
    ]);
  });
});

describe("deleteAccount: unsafe or absent avatar_path -> zero privileged avatar removals", () => {
  it("null avatar_path: no avatar removal, no warning, account deleted", async () => {
    profileResult = { data: { avatar_path: null }, error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(avatarRemovals()).toEqual([]);
    expect(console.warn).not.toHaveBeenCalled();
    expect(events).toContain(`deleteUser:${USER_ID}`);
  });

  it("no profile row at all: no avatar removal, account deleted", async () => {
    profileResult = { data: null, error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(avatarRemovals()).toEqual([]);
    expect(events).toContain(`deleteUser:${USER_ID}`);
  });

  it.each(UNSAFE_AVATAR_PATHS_FOR_USER.filter(([, value]) => value !== null && value !== undefined))(
    "%s: skipped, never passed to service-role remove",
    async (_label, value) => {
      profileResult = { data: { avatar_path: value }, error: null };

      expect(await run()).toBe("/?account=deleted");

      expect(avatarRemovals()).toEqual([]);
      expect(storageCalls.filter((c) => JSON.stringify(c.paths ?? null).includes("avatar"))).toEqual([]);
      expect(events).toContain(`deleteUser:${USER_ID}`);
      expect(console.warn).toHaveBeenCalledWith(
        "deleteAccount: stored avatar_path is not this user's canonical avatar key; avatar cleanup skipped",
      );
      // The stored value is never logged.
      for (const call of [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.error).mock.calls]) {
        expect(JSON.stringify(call)).not.toContain(OTHER_ID);
      }
    },
  );

  it("an unsafe avatar does not suppress, and is not masked by, the unchanged book cleanup", async () => {
    profileResult = { data: { avatar_path: `${OTHER_ID}/avatar.png` }, error: null };
    books = [OWN_BOOK];

    expect(await run()).toBe("/?account=deleted");

    expect(avatarRemovals()).toEqual([]);
    expect(nonAvatarRemovals().map((c) => c.bucket)).toEqual(["covers", "manuscripts"]);
    expect(JSON.stringify(nonAvatarRemovals())).not.toContain(OTHER_ID);
  });

  it("the check is bound to the deleting user: another user's genuinely canonical key is still foreign", async () => {
    profileResult = { data: { avatar_path: `${OTHER_ID}/avatar.jpg` }, error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(avatarRemovals()).toEqual([]);
  });
});

describe("deleteAccount: failures stop before anything irreversible", () => {
  it("a failed profile read stops: no admin client, no deleteUser, no removal of any kind", async () => {
    profileResult = { data: { avatar_path: `${OTHER_ID}/avatar.png` }, error: { message: "db down" } };

    expect(await run()).toBe("/account?error=Nuk%20mund%C3%ABm%20ta%20p%C3%ABrgatisim%20fshirjen%20e%20llogaris%C3%AB.%20Provoni%20p%C3%ABrs%C3%ABri.");

    expect(adminClientsCreated).toBe(0);
    expect(events.some((e) => e.startsWith("deleteUser"))).toBe(false);
    expect(storageCalls).toEqual([]);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("a failed profile read that still carries a canonical-looking row is not trusted either", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: { message: "partial" } };
    expect(await run()).toContain("/account?error=");
    expect(storageCalls).toEqual([]);
    expect(adminClientsCreated).toBe(0);
  });

  it("a failed Auth user deletion leaves every file, including a valid avatar, untouched", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    books = [OWN_BOOK];
    deleteUserError = { message: "restrict violation" };

    expect(await run()).toBe("/account?error=Di%C3%A7ka%20shkoi%20keq%20gjat%C3%AB%20fshirjes%20s%C3%AB%20llogaris%C3%AB.%20Provoni%20p%C3%ABrs%C3%ABri.");
    expect(storageCalls).toEqual([]);
  });

  it("a failed avatar removal is logged, not surfaced: the account is already gone", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    failingRemoveBucket = "avatars";

    expect(await run()).toBe("/?account=deleted");
    expect(avatarRemovals()).toHaveLength(1);
    expect(console.error).toHaveBeenCalledWith("deleteAccount: failed to remove orphaned avatar file:", { message: "storage down" });
  });
});

describe("deleteAccount: existing gates are intact and run before any profile read or privileged call", () => {
  it("an active recovery session is sent to /reset-password first", async () => {
    cookieStore.get.mockImplementation((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined));
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    expect(await run()).toContain("/reset-password");
    expect(events).toEqual([]);
    expect(adminClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
  });

  it("unauthenticated: /login, nothing read, nothing removed", async () => {
    authUser = null;
    expect(await run()).toBe("/login");
    expect(events).toEqual([]);
    expect(adminClientsCreated).toBe(0);
  });

  it("active staff: blocked before the profile read", async () => {
    staffResult = { data: { role: "owner" }, error: null };
    expect(await run()).toBe("/account?error=Hiqeni%20k%C3%ABt%C3%AB%20llogari%20nga%20stafi%20i%20Librum%20para%20se%20ta%20fshini.");
    expect(events).toEqual(["read:staff"]);
    expect(adminClientsCreated).toBe(0);
  });

  it("staff lookup error: blocked before the profile read", async () => {
    staffResult = { data: null, error: { message: "x" } };
    expect(await run()).toBe("/account?error=Nuk%20mund%C3%ABm%20t%C3%AB%20kontrollojm%C3%AB%20n%C3%ABse%20kjo%20llogari%20mund%20t%C3%AB%20fshihet.%20Provoni%20p%C3%ABrs%C3%ABri.");
    expect(events).toEqual(["read:staff"]);
    expect(adminClientsCreated).toBe(0);
  });

  it.each(["", "fshi", "FSHI ", "Fshi", "DELETE"])("wrong confirmation %j: blocked before the profile read", async (confirmation) => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    expect(await run(confirmation)).toBe("/account?error=Shkruani%20FSHI%20p%C3%ABr%20ta%20konfirmuar.");
    expect(events).toEqual(["read:staff"]);
    expect(adminClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
  });

  it("books with acquisitions: blocked before any privileged call", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    books = [OWN_BOOK];
    purchaseCount = 1;
    expect(await run()).toContain("/account?error=Llogaria%20juaj%20nuk%20mund%20t%C3%AB%20fshihet");
    expect(adminClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
  });

  it("the happy path deletes exactly the authenticated user", async () => {
    expect(await run()).toBe("/?account=deleted");
    expect(events.filter((e) => e.startsWith("deleteUser"))).toEqual([`deleteUser:${USER_ID}`]);
  });
});

// PEN-NAMES-1: pen name photos live in the avatars bucket under a random
// folder (<uuid>/pen-name.<ext>); deleteAccount removes the account's own
// ones (read from its own pen_names rows) after deleteUser, and only
// values of exactly that shape.
describe("deleteAccount: pen name photos", () => {
  const PHOTO_A = "d0000000-0000-4000-8000-000000000001/pen-name.png";
  const PHOTO_B = "d0000000-0000-4000-8000-000000000002/pen-name.jpg";

  it("removes every canonical pen name photo, once, after deleteUser, beside the profile avatar", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    penNamesResult = {
      data: [{ avatar_path: PHOTO_A }, { avatar_path: null }, { avatar_path: PHOTO_B }],
      error: null,
    };

    expect(await run()).toBe("/?account=deleted");

    expect(avatarRemovals()).toEqual([
      { via: "service", bucket: "avatars", op: "remove", paths: [`${USER_ID}/avatar.png`] },
      { via: "service", bucket: "avatars", op: "remove", paths: [PHOTO_A, PHOTO_B] },
    ]);
    expect(events.indexOf("read:pen_names")).toBeLessThan(events.indexOf(`deleteUser:${USER_ID}`));
    expect(events.lastIndexOf("remove:avatars")).toBeGreaterThan(events.indexOf(`deleteUser:${USER_ID}`));
  });

  it.each([
    ["another user's avatar", `${"e0000000-0000-4000-8000-000000000009"}/avatar.png`],
    ["traversal", "d0000000-0000-4000-8000-000000000001/../x/pen-name.png"],
    ["wrong file name", "d0000000-0000-4000-8000-000000000001/avatar.png"],
    ["upper case", "D0000000-0000-4000-8000-000000000001/pen-name.png"],
  ])("a non-canonical stored value (%s) is skipped, never passed to service-role remove", async (_label, value) => {
    penNamesResult = { data: [{ avatar_path: value }], error: null };
    expect(await run()).toBe("/?account=deleted");
    expect(avatarRemovals()).toEqual([]);
    expect(console.warn).toHaveBeenCalled();
  });

  // r4 (17a): the migration copied the profile photo onto the default
  // pen name, so both rows may name the SAME object; it is removed once.
  it("a pen name holding the profile's own photo key: the shared object is removed exactly once", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    penNamesResult = { data: [{ avatar_path: `${USER_ID}/avatar.png` }, { avatar_path: PHOTO_A }], error: null };

    expect(await run()).toBe("/?account=deleted");

    const removed = avatarRemovals().flatMap((c) => c.paths);
    expect(removed.filter((p) => p === `${USER_ID}/avatar.png`)).toHaveLength(1);
    expect(removed.sort()).toEqual([`${USER_ID}/avatar.png`, PHOTO_A].sort());
  });

  it("a pen name still holding the old profile key after the profile moved on: that object is removed too, once", async () => {
    profileResult = { data: { avatar_path: null }, error: null };
    penNamesResult = { data: [{ avatar_path: `${USER_ID}/avatar.jpg` }], error: null };

    expect(await run()).toBe("/?account=deleted");

    expect(avatarRemovals()).toEqual([
      { via: "service", bucket: "avatars", op: "remove", paths: [`${USER_ID}/avatar.jpg`] },
    ]);
  });

  it("a pen names read failure stops before anything irreversible", async () => {
    penNamesResult = { data: null, error: { message: "down" } };
    expect(await run()).toBe("/account?error=Nuk%20mund%C3%ABm%20ta%20p%C3%ABrgatisim%20fshirjen%20e%20llogaris%C3%AB.%20Provoni%20p%C3%ABrs%C3%ABri.");
    expect(events).not.toContain(`deleteUser:${USER_ID}`);
    expect(storageCalls).toEqual([]);
  });
});
