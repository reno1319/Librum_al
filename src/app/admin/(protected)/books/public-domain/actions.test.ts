import { beforeEach, describe, expect, it, vi } from "vitest";

// K6 (Q1 a): the staff actions for classic authors. Maintenance gate
// first, then requireStaff("books.review"), then the form check, then
// the RPC through the staff member's own session; errors are mapped.
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
const mockRequireStaff = vi.fn((_permission: string) => Promise.resolve({ userId: "staff-1", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => Promise.resolve({ rpc: mockRpc }) }));

const { saveClassicAuthorAsStaff, setPdWorkClassicAuthorAsStaff } = await import("./actions");

const AUTHOR_ID = "00000000-0000-4000-8000-0000000000a1";
const WORK_ID = "00000000-0000-4000-8000-0000000000b1";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}
const GOOD = { name: "Naim Frashëri", birthYear: "1846", deathYear: "1900", bio: "Poet." };

async function target(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (e) {
    if (e instanceof RedirectSignal) return decodeURIComponent(e.target);
    throw e;
  }
  throw new Error("no redirect");
}

beforeEach(() => {
  mockRpc.mockReset();
  mockRequireStaff.mockClear();
  vi.unstubAllEnvs();
});

describe("saveClassicAuthorAsStaff", () => {
  it("adds through staff_save_classic_author after books.review, then opens the saved author", async () => {
    mockRpc.mockResolvedValue({ data: AUTHOR_ID, error: null });
    expect(await target(saveClassicAuthorAsStaff(form(GOOD)))).toBe(
      `/admin/books/public-domain/authors/${AUTHOR_ID}?success=Classic author saved.`,
    );
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(mockRpc).toHaveBeenCalledWith("staff_save_classic_author", {
      p_id: null, p_slug: "naim-frasheri", p_name: "Naim Frashëri", p_birth_year: 1846, p_death_year: 1900,
      p_birth_place: null, p_death_place: null, p_bio: "Poet.",
    });
  });

  it("a bad form never reaches the database; an edit goes back to its own page", async () => {
    expect(await target(saveClassicAuthorAsStaff(form({ ...GOOD, id: AUTHOR_ID, bio: "" })))).toBe(
      `/admin/books/public-domain/authors/${AUTHOR_ID}?error=Write a bio (at most 3000 characters).`,
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("maps a taken slug", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    mockRpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate" } });
    expect(await target(saveClassicAuthorAsStaff(form(GOOD)))).toBe(
      "/admin/books/public-domain/authors?error=Another classic author already uses this web address.",
    );
    quiet.mockRestore();
  });

  it("maintenance mode stops it before the staff check", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    await expect(saveClassicAuthorAsStaff(form(GOOD))).rejects.toThrow();
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe("setPdWorkClassicAuthorAsStaff", () => {
  it("links and unlinks a work", async () => {
    mockRpc.mockResolvedValue({ data: null, error: null });
    expect(await target(setPdWorkClassicAuthorAsStaff(form({ workId: WORK_ID, classicAuthorId: AUTHOR_ID })))).toBe(
      "/admin/books/public-domain?success=Classic author link saved.",
    );
    expect(mockRpc).toHaveBeenLastCalledWith("staff_set_pd_work_classic_author", { p_work_id: WORK_ID, p_author_id: AUTHOR_ID });
    await target(setPdWorkClassicAuthorAsStaff(form({ workId: WORK_ID, classicAuthorId: "" })));
    expect(mockRpc).toHaveBeenLastCalledWith("staff_set_pd_work_classic_author", { p_work_id: WORK_ID, p_author_id: null });
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
  });

  it("refuses ids that are not uuids without calling the database", async () => {
    expect(await target(setPdWorkClassicAuthorAsStaff(form({ workId: "x", classicAuthorId: "" })))).toBe(
      "/admin/books/public-domain?error=This author or work no longer exists.",
    );
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
