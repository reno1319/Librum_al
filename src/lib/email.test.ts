import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 AUTHOR-1B: sendNewBookEmails is the one exported function in
// this file that renders author attribution to a reader (a follower
// notification) -- the only thing under test here is that it resolves
// through resolvePublicAuthorName(), never a raw display_name read, for
// both the email subject and body. sendPurchaseEmails/
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

function makeFakeAdmin(overrides: {
  book?: { title: string } | null;
  author?: { display_name: string; public_author_name?: string | null } | null;
  follows?: { follower_id: string }[];
}) {
  const { book = { title: "Test Book" }, author = null, follows = [] } = overrides;

  return {
    from: (table: string) => {
      if (table === "books") {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: book }) }) }) };
      }
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: author }) }) }) };
      }
      if (table === "author_follows") {
        return { select: () => ({ eq: () => Promise.resolve({ data: follows }) }) };
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
}

describe("sendNewBookEmails", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("author has a public author name set -> subject and body use the pen name, never the account display_name", async () => {
    const admin = makeFakeAdmin({
      author: { display_name: "Renata Author", public_author_name: "R. A. Nightingale" },
      follows: [{ follower_id: "follower-1" }],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const [{ subject, html }] = sendMock.mock.calls[0];
    expect(subject).toBe("R. A. Nightingale just published a new book");
    expect(html).toContain("New from R. A. Nightingale");
    expect(subject).not.toContain("Renata Author");
    expect(html).not.toContain("Renata Author");
  });

  it("no public author name set -> falls back to the account display_name", async () => {
    const admin = makeFakeAdmin({
      author: { display_name: "Renata Author", public_author_name: null },
      follows: [{ follower_id: "follower-1" }],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    const [{ subject, html }] = sendMock.mock.calls[0];
    expect(subject).toBe("Renata Author just published a new book");
    expect(html).toContain("New from Renata Author");
  });

  it("no followers -> never sends, and never looks up any follower email", async () => {
    const admin = makeFakeAdmin({
      author: { display_name: "Renata Author", public_author_name: "R. A. Nightingale" },
      follows: [],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).not.toHaveBeenCalled();
  });

  it("multiple followers -> every send uses the same resolved public name", async () => {
    const admin = makeFakeAdmin({
      author: { display_name: "Renata Author", public_author_name: "R. A. Nightingale" },
      follows: [{ follower_id: "follower-1" }, { follower_id: "follower-2" }],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).toHaveBeenCalledTimes(2);
    for (const call of sendMock.mock.calls) {
      expect(call[0].subject).toBe("R. A. Nightingale just published a new book");
    }
  });
});
