import { beforeEach, describe, expect, it, vi } from "vitest";

// BD16 P5: the pre-order emails. A small in-memory fake of the two
// tables answers the same PostgREST chains the code uses, so "claimed
// before sent" and "runs twice, sends once" are tested against the
// rows themselves. All ids and addresses are made up.

vi.mock("server-only", () => ({}));
const afterTasks: (() => Promise<unknown>)[] = [];
vi.mock("next/server", () => ({ after: (task: () => Promise<unknown>) => afterTasks.push(task) }));

type Row = { book_id: string; user_id: string; notified_at: string | null; book_cancelled_at: string | null };
type Book = { id: string; title: string; author_id: string; status: string; release_date: string | null };

let rows: Row[] = [];
let books: Book[] = [];
let failClaim = false;
// r2 (audit F1-F3): a failed titles read, failing address lookups, no
// key, and Resend's answer per batch call ("ok", "refuse" = returned
// { error }, "throw" = outcome unknown).
let failBooksRead = false;
let failingLookups = new Set<string>();
let keyConfigured = true;
// r3: "unknown" = no status / 5xx / dropped (maybe sent); "bad1" = with
// permissive validation Resend refused the 2nd address only.
let batchAnswers: ("ok" | "refuse" | "throw" | "unknown" | "bad1" | "allbad")[] = [];
const batchOptions: unknown[] = [];

const sent: { to: string; subject: string }[] = [];
const mockBatch = vi.fn(async (messages: { to: string; subject: string; html: string }[], options?: unknown) => {
  batchOptions.push(options);
  const answer = batchAnswers.shift() ?? "ok";
  if (answer === "refuse") return { notSent: messages.map((_m, i) => i), invalid: [] };
  if (answer === "throw" || answer === "unknown") return { notSent: [], invalid: [] }; // may have gone out
  if (answer === "allbad") return { notSent: [], invalid: messages.map((_m, i) => i) };
  if (answer === "bad1") {
    messages.forEach((m, i) => i !== 1 && sent.push({ to: m.to, subject: m.subject }));
    return { notSent: [], invalid: messages.length > 1 ? [1] : [] };
  }
  for (const m of messages) sent.push({ to: m.to, subject: m.subject });
  return { notSent: [], invalid: [] };
});
const mockNewBook = vi.fn(async (_admin: unknown, _args: { bookId: string; authorId: string }) => undefined);
const authorMails: { kind: string; to: string; args: unknown }[] = [];
vi.mock("@/lib/email", () => ({
  EMAIL_BATCH_SIZE: 100,
  emailSendingConfigured: () => keyConfigured,
  sendEmailBatch: (messages: { to: string; subject: string; html: string }[], options?: unknown) =>
    mockBatch(messages, options),
  sendNewBookEmails: (admin: unknown, args: { bookId: string; authorId: string }) => mockNewBook(admin, args),
  preorderReleasedReaderEmail: ({ title }: { title: string }) => ({ subject: `released:${title}`, html: "" }),
  preorderCancelledReaderEmail: ({ title }: { title: string }) => ({ subject: `cancelled:${title}`, html: "" }),
  preorderDateMovedReaderEmail: ({ title, releaseDate }: { title: string; releaseDate: string }) => ({
    subject: `moved:${title}:${releaseDate}`,
    html: "",
  }),
  sendPreorderReleasedAuthorEmail: async (to: string, args: unknown) => void authorMails.push({ kind: "released", to, args }),
  sendPreorderDateMovedEmail: async (to: string, args: unknown) => void authorMails.push({ kind: "moved", to, args }),
  sendPreorderCancelledAuthorEmail: async (to: string, args: unknown) => void authorMails.push({ kind: "cancelled", to, args }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeAdmin() }));

type Filter = (r: Record<string, unknown>) => boolean;

function query(table: string) {
  const filters: Filter[] = [];
  let update: Record<string, unknown> | null = null;
  const source = () => (table === "books" ? (books as unknown as Record<string, unknown>[]) : (rows as unknown as Record<string, unknown>[]));
  const field = (r: Record<string, unknown>, column: string) => {
    if (column === "books.status") return books.find((b) => b.id === r.book_id)?.status;
    return r[column];
  };
  let limit = Infinity;
  let columns = "";
  const run = () => {
    if (update && failClaim) return { data: null, error: { code: "XX000" } };
    if (table === "books" && failBooksRead) return { data: null, error: { code: "57014" } };
    const hit = source()
      .filter((r) => filters.every((f) => f(r)))
      .slice(0, limit);
    if (update) for (const r of hit) Object.assign(r, update);
    // R22: the embedded book title (books!inner(title)); a row whose
    // book is gone drops out, like an inner join.
    if (columns.includes("books!inner(title)")) {
      const joined = hit.flatMap((r) => {
        const book = books.find((b) => b.id === r.book_id);
        return book ? [{ ...r, books: { title: book.title } }] : [];
      });
      return { data: joined, error: null };
    }
    return { data: hit.map((r) => ({ ...r })), error: null };
  };
  const chain = {
    select: (c?: string) => {
      if (typeof c === "string") columns = c;
      return chain;
    },
    order: () => chain,
    limit: (n: number) => {
      limit = n;
      return chain;
    },
    update: (values: Record<string, unknown>) => {
      update = values;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters.push((r) => field(r, column) === value);
      return chain;
    },
    in: (column: string, values: unknown[]) => {
      filters.push((r) => values.includes(r[column]));
      return chain;
    },
    is: (column: string, value: null) => {
      filters.push((r) => r[column] === value);
      return chain;
    },
    not: (column: string, _op: "is", value: null) => {
      filters.push((r) => r[column] !== value);
      return chain;
    },
    returns: () => Promise.resolve(run()),
  };
  return chain;
}

function fakeAdmin() {
  return {
    from: (table: string) => query(table),
    auth: {
      admin: {
        getUserById: async (id: string) => {
          if (failingLookups.has(id)) throw new Error("network");
          if (id.startsWith("gone")) return { data: { user: null }, error: null };
          return { data: { user: { email: `${id}@example.test` } }, error: null };
        },
      },
    },
  } as never;
}

const {
  sendWaitingReaderEmails,
  sendPreorderJobEmails,
  scheduleWaitingReaderEmails,
  sendDateMovedReaderEmails,
  scheduleDateMovedReaderEmails,
  readWaitingReadersForBooks,
  sendDeletedBooksCancelledEmails,
  scheduleDeletedBooksCancelledEmails,
} = await import("./preorder-emails");

function summary(over: Partial<{ releasedBookIds: string[]; slipped: { bookId: string; releaseDate: string }[]; cancelledBookIds: string[] }> = {}) {
  return { today: "2026-12-01", releasedBookIds: [], slipped: [], cancelledBookIds: [], overdueBookIds: [], failed: [], ...over };
}

beforeEach(() => {
  books = [
    { id: "b-rel", title: "Released", author_id: "author-1", status: "published", release_date: "2026-12-01" },
    { id: "b-wait", title: "Waiting", author_id: "author-1", status: "preorder", release_date: "2026-12-20" },
    { id: "b-cxl", title: "Cancelled", author_id: "author-2", status: "draft", release_date: null },
  ];
  rows = [
    { book_id: "b-rel", user_id: "r1", notified_at: null, book_cancelled_at: null },
    { book_id: "b-rel", user_id: "r2", notified_at: null, book_cancelled_at: null },
    { book_id: "b-rel", user_id: "r3", notified_at: "2026-11-30T08:00:00Z", book_cancelled_at: null },
    { book_id: "b-wait", user_id: "r1", notified_at: null, book_cancelled_at: null },
    { book_id: "b-cxl", user_id: "r4", notified_at: null, book_cancelled_at: "2026-11-30T10:00:00Z" },
  ];
  failClaim = false;
  failBooksRead = false;
  failingLookups = new Set();
  keyConfigured = true;
  batchAnswers = [];
  batchOptions.length = 0;
  sent.length = 0;
  authorMails.length = 0;
  afterTasks.length = 0;
  mockBatch.mockClear();
  mockNewBook.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("sendWaitingReaderEmails", () => {
  it("sends each unsent row its one email and marks it: release for a published book, cancel for an ended one", async () => {
    const counts = await sendWaitingReaderEmails(fakeAdmin());
    expect(counts).toEqual({ released: 2, cancelled: 1 });
    expect(sent).toEqual([
      { to: "r4@example.test", subject: "cancelled:Cancelled" },
      { to: "r1@example.test", subject: "released:Released" },
      { to: "r2@example.test", subject: "released:Released" },
    ]);
    // r3 was already told; the still-waiting pre-order is untouched.
    expect(rows.find((r) => r.book_id === "b-wait")?.notified_at).toBeNull();
    expect(rows.filter((r) => r.book_id !== "b-wait").every((r) => r.notified_at !== null)).toBe(true);
  });

  it("runs twice, sends once (an immediate send, then the daily job)", async () => {
    await sendWaitingReaderEmails(fakeAdmin());
    const first = sent.length;
    const again = await sendWaitingReaderEmails(fakeAdmin());
    expect(again).toEqual({ released: 0, cancelled: 0 });
    expect(sent).toHaveLength(first);
  });

  it("the immediate send after an action, then the job's run, then the owner's button: each reader once", async () => {
    scheduleWaitingReaderEmails("test");
    await afterTasks[0]();
    await sendPreorderJobEmails(fakeAdmin(), summary());
    await sendPreorderJobEmails(fakeAdmin(), null);
    const perRecipient = new Map<string, number>();
    for (const m of sent) perRecipient.set(`${m.to}|${m.subject}`, (perRecipient.get(`${m.to}|${m.subject}`) ?? 0) + 1);
    expect([...perRecipient.values()].every((n) => n === 1)).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("a row claimed by another run in between is not sent again", async () => {
    // Another run claims b-rel's rows just after this run read them.
    const original = rows.map((r) => ({ ...r }));
    rows.forEach((r) => {
      if (r.book_id === "b-rel") r.notified_at = "2026-12-01T08:00:01Z";
    });
    const counts = await sendWaitingReaderEmails(fakeAdmin());
    expect(counts.released).toBe(0);
    expect(sent.some((m) => m.subject.startsWith("released"))).toBe(false);
    rows = original;
  });

  it("a failed claim sends nothing and logs no address", async () => {
    failClaim = true;
    const counts = await sendWaitingReaderEmails(fakeAdmin());
    expect(counts).toEqual({ released: 0, cancelled: 0 });
    expect(mockBatch).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("@");
  });

  it("a reader who asked again after a cancel (fresh row) gets the release email of the new pre-order", async () => {
    books.find((b) => b.id === "b-cxl")!.status = "published";
    rows.find((r) => r.book_id === "b-cxl")!.book_cancelled_at = null;
    await sendWaitingReaderEmails(fakeAdmin());
    expect(sent).toContainEqual({ to: "r4@example.test", subject: "released:Cancelled" });
    expect(sent.some((m) => m.subject === "cancelled:Cancelled")).toBe(false);
  });
});

describe("sendPreorderJobEmails", () => {
  it("tells each author what the job did, emails followers of released books, then sweeps the readers", async () => {
    books.push({ id: "b-slip", title: "Slipped", author_id: "author-3", status: "preorder", release_date: "2026-12-31" });
    await sendPreorderJobEmails(
      fakeAdmin(),
      summary({ releasedBookIds: ["b-rel"], slipped: [{ bookId: "b-slip", releaseDate: "2026-12-31" }], cancelledBookIds: ["b-cxl"] }),
    );
    expect(authorMails).toEqual([
      { kind: "released", to: "author-1@example.test", args: { title: "Released", bookId: "b-rel" } },
      { kind: "moved", to: "author-3@example.test", args: { title: "Slipped", releaseDate: "2026-12-31" } },
      { kind: "cancelled", to: "author-2@example.test", args: { title: "Cancelled" } },
    ]);
    expect(mockNewBook).toHaveBeenCalledTimes(1);
    expect(mockNewBook.mock.calls[0][1]).toEqual({ bookId: "b-rel", authorId: "author-1" });
    // 3 release/cancel emails; b-slip has no waiting reader in this set.
    expect(sent).toHaveLength(3);
  });

  it("a second run of the same day (empty summary) sends nothing to anyone", async () => {
    await sendPreorderJobEmails(fakeAdmin(), summary({ releasedBookIds: ["b-rel"] }));
    const authors = authorMails.length;
    const readers = sent.length;
    await sendPreorderJobEmails(fakeAdmin(), summary());
    expect(authorMails).toHaveLength(authors);
    expect(sent).toHaveLength(readers);
    expect(mockNewBook).toHaveBeenCalledTimes(1);
  });

  it("a failed database step (null) still sweeps the readers, with no author or follower email", async () => {
    const counts = await sendPreorderJobEmails(fakeAdmin(), null);
    expect(counts).toEqual({ released: 2, cancelled: 1 });
    expect(authorMails).toHaveLength(0);
    expect(mockNewBook).not.toHaveBeenCalled();
  });
});

describe("scheduleWaitingReaderEmails", () => {
  it("runs the sweep only after the page has answered", async () => {
    scheduleWaitingReaderEmails("test");
    expect(sent).toHaveLength(0);
    await afterTasks[0]();
    expect(sent).toHaveLength(3);
  });
});

describe("the one 'new date' email (Renato 11-06)", () => {
  it("goes to the still-waiting readers only, and leaves their release mark alone", async () => {
    rows.push(
      { book_id: "b-wait", user_id: "r5", notified_at: null, book_cancelled_at: null },
      { book_id: "b-wait", user_id: "r6", notified_at: null, book_cancelled_at: "2026-11-01T08:00:00Z" },
    );
    const n = await sendDateMovedReaderEmails(fakeAdmin(), { bookId: "b-wait", releaseDate: "2027-01-19" });
    expect(n).toBe(2);
    expect(sent).toEqual([
      { to: "r1@example.test", subject: "moved:Waiting:2027-01-19" },
      { to: "r5@example.test", subject: "moved:Waiting:2027-01-19" },
    ]);
    expect(rows.filter((r) => r.book_id === "b-wait" && r.book_cancelled_at === null).every((r) => r.notified_at === null)).toBe(true);
  });

  it("the job's slip sends it with the author's email; the same day's second run sends neither again", async () => {
    const slip = summary({ slipped: [{ bookId: "b-wait", releaseDate: "2027-01-19" }] });
    await sendPreorderJobEmails(fakeAdmin(), slip);
    // Second run: run_preorder_day reports a slip only in the run that applied it.
    await sendPreorderJobEmails(fakeAdmin(), summary());
    expect(sent.filter((m) => m.subject.startsWith("moved:"))).toEqual([{ to: "r1@example.test", subject: "moved:Waiting:2027-01-19" }]);
    expect(authorMails.filter((m) => m.kind === "moved")).toHaveLength(1);
  });

  it("the author's push, then the job's runs: the readers hear about the move once", async () => {
    scheduleDateMovedReaderEmails("test", { bookId: "b-wait", releaseDate: "2027-01-10" });
    await afterTasks[0]();
    // The push used the one move, so the job never reports a slip for it.
    await sendPreorderJobEmails(fakeAdmin(), summary());
    await sendPreorderJobEmails(fakeAdmin(), summary());
    expect(sent.filter((m) => m.subject.startsWith("moved:"))).toHaveLength(1);
    // Later, the release: still the one release email.
    books.find((b) => b.id === "b-wait")!.status = "published";
    await sendPreorderJobEmails(fakeAdmin(), summary());
    await sendPreorderJobEmails(fakeAdmin(), summary());
    expect(sent.filter((m) => m.subject === "released:Waiting")).toEqual([{ to: "r1@example.test", subject: "released:Waiting" }]);
  });

  it("an unreadable list sends nothing and logs no address", async () => {
    failClaim = false;
    const admin = {
      from: () => ({ select: () => ({ eq: () => ({ is: () => ({ is: () => ({ returns: async () => ({ data: null, error: { code: "42501" } }) }) }) }) }) }),
      auth: { admin: { getUserById: async () => ({ data: null }) } },
    } as never;
    expect(await sendDateMovedReaderEmails(admin, { bookId: "b-wait", releaseDate: "2027-01-19" })).toBe(0);
    expect(mockBatch).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("@");
  });
});

describe("r2: a claimed email is never lost for an avoidable reason (audit F1-F3)", () => {
  const unsent = () => rows.filter((r) => r.notified_at === null).map((r) => `${r.book_id}|${r.user_id}`).sort();

  it("F1: a failed titles read claims nothing; the next healthy run sends every one once", async () => {
    failBooksRead = true;
    expect(await sendWaitingReaderEmails(fakeAdmin())).toEqual({ released: 0, cancelled: 0 });
    expect(unsent()).toEqual(["b-cxl|r4", "b-rel|r1", "b-rel|r2", "b-wait|r1"]);
    failBooksRead = false;
    expect(await sendWaitingReaderEmails(fakeAdmin())).toEqual({ released: 2, cancelled: 1 });
    await sendWaitingReaderEmails(fakeAdmin());
    expect(sent).toHaveLength(3);
  });

  it("F1: a thrown address lookup leaves that reader unclaimed for the next run; the others go now", async () => {
    failingLookups = new Set(["r2"]);
    await sendWaitingReaderEmails(fakeAdmin());
    expect(unsent()).toEqual(["b-rel|r2", "b-wait|r1"]);
    failingLookups = new Set();
    await sendWaitingReaderEmails(fakeAdmin());
    expect(sent.filter((m) => m.to === "r2@example.test")).toEqual([{ to: "r2@example.test", subject: "released:Released" }]);
    expect(sent).toHaveLength(3);
  });

  it("a reader with no account address is marked and skipped (not retried forever)", async () => {
    rows.push({ book_id: "b-rel", user_id: "gone-1", notified_at: null, book_cancelled_at: null });
    await sendWaitingReaderEmails(fakeAdmin());
    expect(rows.find((r) => r.user_id === "gone-1")?.notified_at).not.toBeNull();
  });

  it("F2: with no RESEND_API_KEY nothing is claimed and nothing sent", async () => {
    keyConfigured = false;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await sendWaitingReaderEmails(fakeAdmin())).toEqual({ released: 0, cancelled: 0 });
    expect(mockBatch).not.toHaveBeenCalled();
    expect(unsent()).toEqual(["b-cxl|r4", "b-rel|r1", "b-rel|r2", "b-wait|r1"]);
  });

  it("F3: a batch Resend refused is un-claimed; the rerun sends it once; the refused run does not spin", async () => {
    batchAnswers = ["ok", "refuse"]; // the cancel batch goes, the release batch is refused
    await sendWaitingReaderEmails(fakeAdmin());
    expect(mockBatch).toHaveBeenCalledTimes(2); // no retry inside the same run
    expect(unsent()).toEqual(["b-rel|r1", "b-rel|r2", "b-wait|r1"]);
    await sendWaitingReaderEmails(fakeAdmin());
    await sendWaitingReaderEmails(fakeAdmin());
    expect(sent.filter((m) => m.subject === "released:Released")).toHaveLength(2);
    expect(sent).toHaveLength(3);
  });

  it("F3: a batch that threw (may have gone out) stays claimed and is never resent", async () => {
    batchAnswers = ["ok", "throw"];
    await sendWaitingReaderEmails(fakeAdmin());
    await sendWaitingReaderEmails(fakeAdmin());
    expect(unsent()).toEqual(["b-wait|r1"]);
    expect(mockBatch).toHaveBeenCalledTimes(2);
  });

  it("the un-claim touches only its own claim's rows (a row told earlier keeps its mark)", async () => {
    batchAnswers = ["ok", "refuse"];
    await sendWaitingReaderEmails(fakeAdmin());
    expect(rows.find((r) => r.user_id === "r3")?.notified_at).toBe("2026-11-30T08:00:00Z");
  });

  it("works in chunks of 100: 250 waiting readers of one book, each sent once, in batches of at most 100", async () => {
    rows = Array.from({ length: 250 }, (_v, i) => ({ book_id: "b-rel", user_id: `u${i}`, notified_at: null, book_cancelled_at: null }));
    const counts = await sendWaitingReaderEmails(fakeAdmin());
    expect(counts.released).toBe(250);
    expect(new Set(sent.map((m) => m.to)).size).toBe(250);
    expect(mockBatch.mock.calls.every(([m]) => m.length <= 100)).toBe(true);
    await sendWaitingReaderEmails(fakeAdmin());
    expect(sent).toHaveLength(250);
  });
});

describe("r3: unknown outcomes and bad addresses (audit G1, G2)", () => {
  const unsent = () => rows.filter((r) => r.notified_at === null).map((r) => `${r.book_id}|${r.user_id}`).sort();

  it("G1: an unknown outcome (5xx, dropped connection) stays marked; the reruns never resend it", async () => {
    batchAnswers = ["ok", "unknown"];
    await sendWaitingReaderEmails(fakeAdmin());
    expect(unsent()).toEqual(["b-wait|r1"]);
    await sendWaitingReaderEmails(fakeAdmin());
    await sendWaitingReaderEmails(fakeAdmin());
    expect(mockBatch).toHaveBeenCalledTimes(2);
  });

  it("G2: reader batches go with permissive validation", async () => {
    await sendWaitingReaderEmails(fakeAdmin());
    expect(batchOptions.every((o) => (o as { permissive?: boolean }).permissive === true)).toBe(true);
  });

  it("G2: one bad address among 3: the 2 go once, the bad one stays marked and is never retried, nobody is blocked", async () => {
    rows = [
      { book_id: "b-rel", user_id: "a1", notified_at: null, book_cancelled_at: null },
      { book_id: "b-rel", user_id: "bad", notified_at: null, book_cancelled_at: null },
      { book_id: "b-rel", user_id: "a3", notified_at: null, book_cancelled_at: null },
      { book_id: "b-cxl", user_id: "later", notified_at: null, book_cancelled_at: "2026-11-30T10:00:00Z" },
    ];
    batchAnswers = ["ok", "bad1"]; // the cancel batch first, then the release batch
    const counts = await sendWaitingReaderEmails(fakeAdmin());
    expect(counts).toEqual({ released: 2, cancelled: 1 });
    expect(sent.map((m) => m.to).sort()).toEqual(["a1@example.test", "a3@example.test", "later@example.test"]);
    expect(unsent()).toEqual([]);
    await sendWaitingReaderEmails(fakeAdmin());
    expect(mockBatch).toHaveBeenCalledTimes(2);
  });
});

describe("r3: a full chunk of bad addresses does not stop the sweep", () => {
  it("100 invalid addresses stay marked and the next chunk is still sent in the same run", async () => {
    rows = [
      ...Array.from({ length: 100 }, (_v, i) => ({ book_id: "b-rel", user_id: `bad${i}`, notified_at: null, book_cancelled_at: null })),
      { book_id: "b-rel", user_id: "good", notified_at: null, book_cancelled_at: null },
    ];
    batchAnswers = ["allbad", "ok"];
    await sendWaitingReaderEmails(fakeAdmin());
    expect(sent).toEqual([{ to: "good@example.test", subject: "released:Released" }]);
    expect(rows.every((r) => r.notified_at !== null)).toBe(true);
  });
});

describe("R22 (I3): readers of an account's books when the account is deleted", () => {
  it("reads every unsent row of those books (waiting or cancelled-but-unsent), by book, with the title", async () => {
    const read = await readWaitingReadersForBooks(fakeAdmin(), ["b-rel", "b-wait", "b-cxl", "b-wait"]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect([...read.byBook]).toEqual([
      ["b-rel", { title: "Released", userIds: ["r1", "r2"] }],
      ["b-wait", { title: "Waiting", userIds: ["r1"] }],
      ["b-cxl", { title: "Cancelled", userIds: ["r4"] }],
    ]);
  });

  it("leaves out other books and rows already told", async () => {
    const read = await readWaitingReadersForBooks(fakeAdmin(), ["b-wait"]);
    expect(read.ok && [...read.byBook.keys()]).toEqual(["b-wait"]);
    const none = await readWaitingReadersForBooks(fakeAdmin(), []);
    expect(none.ok && none.byBook.size).toBe(0);
  });

  it("a failed read is ok:false (the deletion stops)", async () => {
    failClaim = false;
    const admin = {
      from: () => ({
        select: () => ({ in: () => ({ is: () => ({ returns: async () => ({ data: null, error: { code: "57014" } }) }) }) }),
      }),
    } as never;
    expect(await readWaitingReadersForBooks(admin, ["b-wait"])).toEqual({ ok: false });
    const throwing = { from: () => { throw new Error("down"); } } as never;
    expect(await readWaitingReadersForBooks(throwing, ["b-wait"])).toEqual({ ok: false });
  });

  it("sends each waiting reader the cancelled email once, and logs no address", async () => {
    const waiting = new Map([
      ["b-wait", { title: "Waiting", userIds: ["r1", "gone-1"] }],
      ["b-cxl", { title: "Cancelled", userIds: ["r4"] }],
    ]);
    expect(await sendDeletedBooksCancelledEmails(fakeAdmin(), waiting)).toBe(2);
    expect(sent).toEqual([
      { to: "r1@example.test", subject: "cancelled:Waiting" },
      { to: "r4@example.test", subject: "cancelled:Cancelled" },
    ]);
    expect(batchOptions).toEqual([{ permissive: true }, { permissive: true }]);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("@");
  });

  it("without an email key nothing is sent", async () => {
    keyConfigured = false;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const waiting = new Map([["b-wait", { title: "Waiting", userIds: ["r1"] }]]);
    expect(await sendDeletedBooksCancelledEmails(fakeAdmin(), waiting)).toBe(0);
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it("one book's failure does not stop the next book", async () => {
    batchAnswers = ["refuse", "ok"];
    const waiting = new Map([
      ["b-wait", { title: "Waiting", userIds: ["r1"] }],
      ["b-cxl", { title: "Cancelled", userIds: ["r4"] }],
    ]);
    expect(await sendDeletedBooksCancelledEmails(fakeAdmin(), waiting)).toBe(1);
    expect(sent).toEqual([{ to: "r4@example.test", subject: "cancelled:Cancelled" }]);
  });

  it("is scheduled after the response, and an empty list schedules nothing", async () => {
    scheduleDeletedBooksCancelledEmails("test", new Map());
    expect(afterTasks).toHaveLength(0);
    scheduleDeletedBooksCancelledEmails("test", new Map([["b-wait", { title: "Waiting", userIds: ["r1"] }]]));
    expect(afterTasks).toHaveLength(1);
    expect(sent).toEqual([]);
    await afterTasks[0]();
    expect(sent).toEqual([{ to: "r1@example.test", subject: "cancelled:Waiting" }]);
  });
});
