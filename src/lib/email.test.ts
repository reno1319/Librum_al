import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 AUTHOR-1B / PEN-NAMES-1: sendNewBookEmails is the one
// exported function in this file that renders author attribution to a
// reader (a follower notification) -- it names the book's pen name. sendPurchaseEmails/
// sendBundlePurchaseEmails/sendSnapshotBundlePurchaseEmails never
// reference author display_name at all and are out of scope.

type SendArgs = { from: string; to: string; subject: string; html: string };
const sendMock = vi.fn((_args: SendArgs) => {
  void _args;
  return Promise.resolve({ data: { id: "email-1" }, error: null });
});
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function (this: unknown) {
    return { emails: { send: sendMock } };
  }),
}));

process.env.RESEND_API_KEY = "test-key";

const { sendNewBookEmails } = await import("./email");

// PEN-NAMES-1 (4a): the email goes to the followers of the BOOK'S pen
// name and names that pen name; the account's names are never read.
function makeFakeAdmin(overrides: {
  book?: { title: string; author_id: string; pen_name_id: string | null } | null;
  penName?: { name: string } | null;
  follows?: { follower_id: string }[];
}) {
  const {
    book = { title: "Test Book", author_id: "author-1", pen_name_id: "pen-1" },
    penName = { name: "R. A. Nightingale" },
    follows = [],
  } = overrides;
  const reads: string[] = [];

  const admin = {
    from: (table: string) => {
      reads.push(table);
      if (table === "books") {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: book }) }) }) };
      }
      if (table === "pen_names") {
        return {
          select: () => ({
            eq: (_column: string, value: string) => ({
              single: () => Promise.resolve({ data: value === book?.pen_name_id ? penName : null }),
            }),
          }),
        };
      }
      if (table === "pen_name_follows") {
        return {
          select: () => ({
            eq: (_column: string, value: string) =>
              Promise.resolve({ data: value === book?.pen_name_id ? follows : [] }),
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    auth: {
      admin: {
        getUserById: (id: string) =>
          Promise.resolve({ data: { user: { email: `${id}@example.com` } } }),
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return Object.assign(admin, { reads });
}

describe("sendNewBookEmails", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("subject and body name the book's pen name; the account (profiles) is never read", async () => {
    const admin = makeFakeAdmin({ follows: [{ follower_id: "follower-1" }] });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ subject, html }] = sendMock.mock.calls[0];
    expect(subject).toBe("R. A. Nightingale just published a new book");
    expect(html).toContain("New from R. A. Nightingale");
    expect(admin.reads).not.toContain("profiles");
    expect(admin.reads).not.toContain("author_follows");
  });

  it("a book of another account, or with no pen name, sends nothing", async () => {
    await sendNewBookEmails(
      makeFakeAdmin({ book: { title: "T", author_id: "someone-else", pen_name_id: "pen-1" }, follows: [{ follower_id: "f" }] }),
      { bookId: "book-1", authorId: "author-1" },
    );
    await sendNewBookEmails(
      makeFakeAdmin({ book: { title: "T", author_id: "author-1", pen_name_id: null }, follows: [{ follower_id: "f" }] }),
      { bookId: "book-1", authorId: "author-1" },
    );
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("no followers -> never sends, and never looks up any follower email", async () => {
    const admin = makeFakeAdmin({ follows: [] });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("multiple followers -> every send uses the same pen name", async () => {
    const admin = makeFakeAdmin({
      follows: [{ follower_id: "follower-1" }, { follower_id: "follower-2" }],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expect(call[0].subject).toBe("R. A. Nightingale just published a new book");
    }
  });
});
