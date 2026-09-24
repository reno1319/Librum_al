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
  if (table === "purchases") {
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

async function run(confirmation = "DELETE"): Promise<string> {
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

    expect(await run()).toBe("/account?error=Unable+to+prepare+account+deletion.+Try+again.");

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

    expect(await run()).toBe("/account?error=Something+went+wrong+deleting+your+account.+Please+try+again");
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
    expect(await run()).toBe("/account?error=Remove+this+account+from+Librum+staff+before+deleting+the+account.");
    expect(events).toEqual(["read:staff"]);
    expect(adminClientsCreated).toBe(0);
  });

  it("staff lookup error: blocked before the profile read", async () => {
    staffResult = { data: null, error: { message: "x" } };
    expect(await run()).toBe("/account?error=Unable+to+verify+account+eligibility+for+deletion.+Try+again.");
    expect(events).toEqual(["read:staff"]);
    expect(adminClientsCreated).toBe(0);
  });

  it.each(["", "delete", "DELETE ", "Delete"])("wrong confirmation %j: blocked before the profile read", async (confirmation) => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    expect(await run(confirmation)).toBe("/account?error=Type+DELETE+to+confirm");
    expect(events).toEqual(["read:staff"]);
    expect(adminClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
  });

  it("books with acquisitions: blocked before any privileged call", async () => {
    profileResult = { data: { avatar_path: `${USER_ID}/avatar.png` }, error: null };
    books = [OWN_BOOK];
    purchaseCount = 1;
    expect(await run()).toContain("/account?error=Your+account+can%27t+be+deleted");
    expect(adminClientsCreated).toBe(0);
    expect(storageCalls).toEqual([]);
  });

  it("the happy path deletes exactly the authenticated user", async () => {
    expect(await run()).toBe("/?account=deleted");
    expect(events.filter((e) => e.startsWith("deleteUser"))).toEqual([`deleteUser:${USER_ID}`]);
  });
});
