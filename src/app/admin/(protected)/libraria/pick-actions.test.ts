import { beforeEach, describe, expect, it, vi } from "vitest";

// LR1 patch 4: saveReadingPick and deleteReadingPick.
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

let rpcResult: { data: unknown; error: { code?: string; message: string } | null };
const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      rpc: (name: string, args: Record<string, unknown>) => (rpcCalls.push({ name, args }), Promise.resolve(rpcResult)),
    }),
}));

const { saveReadingPick, deleteReadingPick } = await import("./pick-actions");
const { PAGE_ERROR_MESSAGES, PAGE_SUCCESS_MESSAGES } = await import("@/lib/page-messages");

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
const PICK = "22222222-2222-4222-8222-222222222222";

function pickForm(fields: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({
    bookId: BOOK,
    badge: "Zgjedhja e Librum",
    note: "Pse e lexojmë.",
    quote: "Një citim.",
    quoteFrom: "book",
    ...fields,
  }))
    fd.set(k, v);
  return fd;
}

// The message in a redirect, which must be one the page will show.
function message(url: string, key: "error" | "success"): string {
  const m = url.match(new RegExp(`[?&]${key}=([^#&]*)`));
  expect(m, url).not.toBeNull();
  const text = m![1];
  expect((key === "error" ? PAGE_ERROR_MESSAGES : PAGE_SUCCESS_MESSAGES).has(text), text).toBe(true);
  return text;
}

beforeEach(() => {
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "staff-1", role: "owner" });
  rpcCalls.length = 0;
  revalidated.length = 0;
  rpcResult = { data: PICK, error: null };
});

describe("saveReadingPick", () => {
  it("a denied staff member stops before anything", async () => {
    mockRequireStaff.mockRejectedValueOnce(new RedirectSignal("/admin"));
    await expect(saveReadingPick(pickForm())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toHaveLength(0);
  });

  it("publishes a new pick: trimmed fields, revalidates Libraria and the Më shumë page", async () => {
    const url = await target(saveReadingPick(pickForm({ note: "  Pse e lexojmë.  ", badge: " Libri i muajit " })));
    expect(rpcCalls).toEqual([
      {
        name: "staff_save_libraria_reading_pick",
        args: { p_id: null, p_book_id: BOOK, p_badge: "Libri i muajit", p_note: "Pse e lexojmë.", p_quote: "Një citim.", p_quote_from: "book" },
      },
    ]);
    expect(message(url, "success")).toBe("Pick published.");
    expect(url.startsWith("/admin/libraria?")).toBe(true);
    expect(url.endsWith("#reading-picks")).toBe(true);
    expect(revalidated).toEqual(["/admin/libraria", "/librari", "/librari/cfare-po-lexojme"]);
  });

  it("an empty badge is sent as no badge; quote from the author", async () => {
    await target(saveReadingPick(pickForm({ badge: "   ", quoteFrom: "author" })));
    expect(rpcCalls[0].args.p_badge).toBeNull();
    expect(rpcCalls[0].args.p_quote_from).toBe("author");
  });

  it("editing says Pick saved.", async () => {
    const url = await target(saveReadingPick(pickForm({ pickId: PICK })));
    expect(rpcCalls[0].args.p_id).toBe(PICK);
    expect(message(url, "success")).toBe("Pick saved.");
  });

  it.each([
    [{ bookId: "" }, "Choose a book."],
    [{ badge: "x".repeat(25) }, "The badge can be at most 24 characters."],
    [{ note: "" }, "Write the note."],
    [{ note: "a\nb" }, "Keep the note as one paragraph."],
    [{ note: "a".repeat(401) }, "The note can be at most 400 characters."],
    [{ quote: " " }, "Write the quote."],
    [{ quote: "a\r\nb" }, "Keep the quote as one paragraph."],
    [{ quote: "q".repeat(241) }, "The quote can be at most 240 characters."],
    [{ quoteFrom: "someone" }, "Choose whether the quote is from the book or from the author."],
    [{ pickId: "not-a-uuid" }, "That pick no longer exists."],
  ])("refuses %o before the database", async (fields, expected) => {
    const url = await target(saveReadingPick(pickForm(fields as Record<string, string>)));
    expect(message(url, "error")).toBe(expected);
    expect(rpcCalls).toHaveLength(0);
  });

  it("a refused edit goes back to the edit form", async () => {
    const url = await target(saveReadingPick(pickForm({ pickId: PICK, note: "" })));
    expect(url.startsWith(`/admin/libraria?pick=${PICK}&error=`)).toBe(true);
  });

  it("a book that is not on Libraria (LB540)", async () => {
    rpcResult = { data: null, error: { code: "LB540", message: "x" } };
    expect(message(await target(saveReadingPick(pickForm())), "error")).toBe("That book is not on Libraria now.");
    expect(revalidated).toHaveLength(0);
  });

  it("an edit of a pick that is gone (null)", async () => {
    rpcResult = { data: null, error: null };
    expect(message(await target(saveReadingPick(pickForm({ pickId: PICK }))), "error")).toBe("That pick no longer exists.");
  });

  it("any other failure", async () => {
    rpcResult = { data: null, error: { code: "P0001", message: "not authorized" } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(message(await target(saveReadingPick(pickForm())), "error")).toBe("Couldn’t save the pick. Please try again.");
    spy.mockRestore();
  });
});

describe("deleteReadingPick", () => {
  function del(id: string): FormData {
    const fd = new FormData();
    fd.set("pickId", id);
    return fd;
  }

  it("checks the permission, deletes and revalidates", async () => {
    rpcResult = { data: true, error: null };
    const url = await target(deleteReadingPick(del(PICK)));
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(rpcCalls).toEqual([{ name: "staff_delete_libraria_reading_pick", args: { p_id: PICK } }]);
    expect(message(url, "success")).toBe("Pick deleted.");
    expect(revalidated).toContain("/librari/cfare-po-lexojme");
  });

  it("a bad id never reaches the database", async () => {
    expect(message(await target(deleteReadingPick(del("x"))), "error")).toBe("That pick no longer exists.");
    expect(rpcCalls).toHaveLength(0);
  });

  it("a pick already gone, or a failure", async () => {
    rpcResult = { data: false, error: null };
    expect(message(await target(deleteReadingPick(del(PICK))), "error")).toBe("That pick no longer exists.");
    rpcResult = { data: null, error: { message: "boom" } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(message(await target(deleteReadingPick(del(PICK))), "error")).toBe("Couldn’t delete the pick. Please try again.");
    spy.mockRestore();
  });
});
