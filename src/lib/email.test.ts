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
// ALBANIAN-12 (PC2): follower emails go through Resend's batch endpoint.
const batchMock = vi.fn((_batch: SendArgs[]) => {
  void _batch;
  return Promise.resolve({ data: { data: [] }, error: null });
});
vi.mock("resend", () => ({
  Resend: vi.fn().mockImplementation(function (this: unknown) {
    return { emails: { send: sendMock }, batch: { send: batchMock } };
  }),
}));

process.env.RESEND_API_KEY = "test-key";

const {
  sendEmailBatch,
  emailSendingConfigured,
  EMAIL_BATCH_SIZE,
  sendNewBookEmails,
  sendBookTakedownEmail,
  sendBookApprovedEmail,
  sendBookChangesApprovedEmail,
  sendBookSentBackEmail,
  sendAccountSuspendedEmail,
  sendAccountSuspensionLiftedEmail,
  escapeEmailHtml,
  preorderReleasedReaderEmail,
  preorderCancelledReaderEmail,
  preorderDateMovedReaderEmail,
  sendPreorderReleasedAuthorEmail,
  sendPreorderDateMovedEmail,
  sendPreorderCancelledAuthorEmail,
} = await import("./email");

// PEN-NAMES-1 (4a): the email goes to the followers of the BOOK'S pen
// name and names that pen name; the account's names are never read.
function makeFakeAdmin(overrides: {
  book?: { title: string; author_id: string; pen_name_id: string | null; pd_work_id?: string | null; pd_editor_credit?: boolean } | null;
  penName?: { name: string } | null;
  follows?: { follower_id: string }[];
  waiters?: { user_id: string; book_cancelled_at: string | null }[];
  waitersError?: { code: string } | null;
}) {
  const {
    waiters = [],
    waitersError = null,
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
      // BD16 P5 (D2): the current pre-order's "Më njofto" readers.
      if (table === "preorder_notify_requests") {
        return {
          select: () => ({
            eq: () => ({
              is: (_column: string, value: null) => ({
                returns: () =>
                  Promise.resolve({
                    data: waitersError ? null : waiters.filter((w) => w.book_cancelled_at === value),
                    error: waitersError,
                  }),
              }),
            }),
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
    batchMock.mockClear();
  });

  it("subject and body name the book's pen name; the account (profiles) is never read", async () => {
    const admin = makeFakeAdmin({ follows: [{ follower_id: "follower-1" }] });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).not.toHaveBeenCalled();
    expect(batchMock).toHaveBeenCalledTimes(1);
    const [batch] = batchMock.mock.calls[0];
    expect(batch).toHaveLength(1);
    const [{ to, subject, html }] = batch;
    expect(to).toBe("follower-1@example.com");
    expect(subject).toBe("R. A. Nightingale publikoi një libër të ri");
    expect(html).toContain("Libër i ri nga R. A. Nightingale");
    expect(html).toContain("<strong>Test Book</strong> sapo doli në Librari.");
    expect(admin.reads).not.toContain("profiles");
    expect(admin.reads).not.toContain("author_follows");
  });

  // PC2: the pen name and title are escaped in the HTML; the footer says
  // why the email came and links to the Following page to stop it.
  it("escapes the pen name and title, and the footer links to the Following page", async () => {
    const admin = makeFakeAdmin({
      book: { title: "<img src=x onerror=alert(1)>", author_id: "author-1", pen_name_id: "pen-1" },
      penName: { name: "A & <b>B</b>" },
      follows: [{ follower_id: "follower-1" }],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    const [{ subject, html }] = batchMock.mock.calls[0][0];
    expect(subject).toBe("A & <b>B</b> publikoi një libër të ri");
    expect(html).toContain("Libër i ri nga A &amp; &lt;b&gt;B&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>B</b>");
    expect(html).toContain("E morët këtë email sepse ndiqni A &amp; &lt;b&gt;B&lt;/b&gt; në Librum.");
    expect(html).toMatch(/<a href="[^"]*\/following">Autorët që ndiqni<\/a> dhe shtypni "Mos ndiqni më"/);
  });

  it("BD15 P7: a public-domain edition without the editor mention sends nothing; with it, it sends", async () => {
    const hidden = makeFakeAdmin({
      book: { title: "Lahuta", author_id: "author-1", pen_name_id: "pen-1", pd_work_id: "work-1", pd_editor_credit: false },
      follows: [{ follower_id: "follower-1" }],
    });
    await sendNewBookEmails(hidden, { bookId: "book-1", authorId: "author-1" });
    expect(batchMock).not.toHaveBeenCalled();
    const credited = makeFakeAdmin({
      book: { title: "Lahuta", author_id: "author-1", pen_name_id: "pen-1", pd_work_id: "work-1", pd_editor_credit: true },
      follows: [{ follower_id: "follower-1" }],
    });
    await sendNewBookEmails(credited, { bookId: "book-1", authorId: "author-1" });
    expect(batchMock).toHaveBeenCalledTimes(1);
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
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("no followers -> never sends, and never looks up any follower email", async () => {
    const admin = makeFakeAdmin({ follows: [] });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(sendMock).not.toHaveBeenCalled();
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("multiple followers -> one batch, every email uses the same pen name", async () => {
    const admin = makeFakeAdmin({
      follows: [{ follower_id: "follower-1" }, { follower_id: "follower-2" }],
    });

    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });

    expect(batchMock).toHaveBeenCalledTimes(1);
    const [batch] = batchMock.mock.calls[0];
    expect(batch.map((m) => m.to)).toEqual(["follower-1@example.com", "follower-2@example.com"]);
    for (const m of batch) expect(m.subject).toBe("R. A. Nightingale publikoi një libër të ri");
  });
});

// PC2: Resend takes at most EMAIL_BATCH_SIZE emails per batch call and
// about 2 calls a second, so batches go one after another.
describe("sendNewBookEmails: BD16 P5 follower dedupe (D2)", () => {
  beforeEach(() => {
    batchMock.mockClear();
  });

  it("leaves out a follower who asked 'Më njofto' for this pre-order (sent or not)", async () => {
    const admin = makeFakeAdmin({
      follows: [{ follower_id: "f-waiting" }, { follower_id: "f-only" }],
      waiters: [{ user_id: "f-waiting", book_cancelled_at: null }, { user_id: "r-not-follower", book_cancelled_at: null }],
    });
    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });
    expect(batchMock.mock.calls[0][0].map((m) => m.to)).toEqual(["f-only@example.com"]);
  });

  it("keeps a follower whose earlier request ended with a cancelled pre-order", async () => {
    const admin = makeFakeAdmin({
      follows: [{ follower_id: "f-old" }],
      waiters: [{ user_id: "f-old", book_cancelled_at: "2026-11-01T08:00:00Z" }],
    });
    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });
    expect(batchMock.mock.calls[0][0].map((m) => m.to)).toEqual(["f-old@example.com"]);
  });

  it("sends nothing when every follower is a waiting reader", async () => {
    const admin = makeFakeAdmin({
      follows: [{ follower_id: "f1" }],
      waiters: [{ user_id: "f1", book_cancelled_at: null }],
    });
    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });
    expect(batchMock).not.toHaveBeenCalled();
  });

  it("an unreadable list still sends to every follower, logging only the code", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const admin = makeFakeAdmin({ follows: [{ follower_id: "f1" }], waitersError: { code: "42501" } });
    await sendNewBookEmails(admin, { bookId: "book-1", authorId: "author-1" });
    expect(batchMock.mock.calls[0][0]).toHaveLength(1);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("@");
    errors.mockRestore();
  });
});

describe("BD16 P5 pre-order emails", () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it("reader release email: title escaped, links to the book, says it is the only one", () => {
    const { subject, html } = preorderReleasedReaderEmail({ title: "<b>Vjeshta</b>", bookId: "book-1" });
    expect(subject).toBe('"<b>Vjeshta</b>" doli në Librum');
    expect(html).toContain("&lt;b&gt;Vjeshta&lt;/b&gt;");
    expect(html).not.toContain("<b>Vjeshta</b>");
    expect(html).toContain("/libra/book-1");
    expect(html).toContain("i vetmi email");
  });

  it("reader cancel email: neutral (never who or why), links to the Librari, says how to ask again", () => {
    const { subject, html } = preorderCancelledReaderEmail({ title: "Vjeshta" });
    expect(subject).toBe('"Vjeshta" nuk do të dalë në datën e njoftuar');
    expect(html).toContain("/librari");
    expect(html).toContain('shtypni përsëri "Më njofto"');
    expect(html).not.toMatch(/autor|Librum e hoqi|takedown/i);
  });

  it("reader new-date email: the new date, title escaped, says the release email still comes", () => {
    const { subject, html } = preorderDateMovedReaderEmail({ title: "A&B", bookId: "book-1", releaseDate: "2027-01-19" });
    expect(subject).toBe('"A&B" del në një datë të re');
    expect(html).toContain("A&amp;B");
    expect(html).toContain("2027");
    expect(html).toContain("/libra/book-1");
    expect(html).toContain("kur të dalë libri");
  });

  it("author emails: released, date moved (new date shown), cancelled", async () => {
    await sendPreorderReleasedAuthorEmail("a@example.com", { title: "T<", bookId: "book-1" });
    await sendPreorderDateMovedEmail("a@example.com", { title: "T", releaseDate: "2026-12-06" });
    await sendPreorderCancelledAuthorEmail("a@example.com", { title: "T" });
    const [released, moved, cancelled] = sendMock.mock.calls.map((c) => c[0]);
    expect(released.subject).toBe('Libri juaj "T<" doli sot në Librum');
    expect(released.html).toContain("T&lt;");
    expect(moved.subject).toBe('Data e daljes së "T" u shty me 30 ditë');
    expect(moved.html).toContain("2026");
    expect(cancelled.subject).toBe('Parapublikimi i "T" u anulua');
  });
});

describe("sendEmailBatch", () => {
  beforeEach(() => batchMock.mockClear());

  const messages = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ to: `r${i}@example.com`, subject: "S", html: "H" }));

  it("splits into batches of EMAIL_BATCH_SIZE, in order, each email carrying the sender", async () => {
    expect(emailSendingConfigured()).toBe(true);
    expect((await sendEmailBatch(messages(1), { pauseMs: 0 })).notSent).toEqual([]);
    batchMock.mockClear();
    await sendEmailBatch(messages(EMAIL_BATCH_SIZE * 2 + 1), { pauseMs: 0 });
    expect(batchMock).toHaveBeenCalledTimes(3);
    expect(batchMock.mock.calls.map(([b]) => b.length)).toEqual([EMAIL_BATCH_SIZE, EMAIL_BATCH_SIZE, 1]);
    expect(batchMock.mock.calls[2][0][0].to).toBe(`r${EMAIL_BATCH_SIZE * 2}@example.com`);
    expect(batchMock.mock.calls[0][0][0].from).toBeTruthy();
  });

  it("pauses between batches, not before the first", async () => {
    vi.useFakeTimers();
    try {
      const done = sendEmailBatch(messages(EMAIL_BATCH_SIZE + 1), { pauseMs: 600 });
      await vi.advanceTimersByTimeAsync(0);
      expect(batchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(599);
      expect(batchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await done;
      expect(batchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused or failed batch is logged without addresses, and the next batch is still sent", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    batchMock.mockResolvedValueOnce({
      data: null,
      error: { name: "rate_limit_exceeded", statusCode: 429, message: "Too many requests for r0@example.com" },
    } as never);
    batchMock.mockRejectedValueOnce(new Error("network down"));
    try {
      // BD16 P5 r2 (audit F3): only the refused batch is reported as
      // surely not sent; the thrown one may have gone out.
      const result = await sendEmailBatch(messages(EMAIL_BATCH_SIZE * 2 + 1), { pauseMs: 0 });
      expect(result.notSent).toEqual(Array.from({ length: EMAIL_BATCH_SIZE }, (_v, i) => i));
      expect(batchMock).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledTimes(2);
      const logged = JSON.stringify(errorSpy.mock.calls[0]);
      expect(logged).toContain("Resend refused it");
      expect(logged).toContain("429");
      expect(logged).not.toContain("example.com");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("sends nothing for an empty list, and skips with a warning (no address) when there is no key", async () => {
    await sendEmailBatch([]);
    expect(batchMock).not.toHaveBeenCalled();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      expect(emailSendingConfigured()).toBe(false);
      expect((await sendEmailBatch(messages(2))).notSent).toEqual([0, 1]);
      expect(batchMock).not.toHaveBeenCalled();
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("example.com");
    } finally {
      process.env.RESEND_API_KEY = key;
      warnSpy.mockRestore();
    }
  });
});

// ADMIN-2-TAKEDOWN (S8): the takedown email escapes every supplied value.
describe("sendBookTakedownEmail", () => {
  beforeEach(() => sendMock.mockClear());

  it("escapes HTML", () => {
    expect(escapeEmailHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("sends the author the reason, the escaped message with its line breaks, and the bundles", async () => {
    await sendBookTakedownEmail("ana@example.com", {
      title: "<b>Kënga</b>",
      reasonLabel: "Ankesë për të drejtën e autorit",
      message: "Line one <script>x</script>\nLine two",
      bundleTitles: ["Set & Co"],
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
    const args = sendMock.mock.calls[0][0];
    expect(args.to).toBe("ana@example.com");
    expect(args.subject).toBe("Librum e hoqi librin tuaj nga Libraria");
    expect(args.html).toContain("&lt;b&gt;Kënga&lt;/b&gt;");
    expect(args.html).toContain("Arsyeja: Ankesë për të drejtën e autorit");
    expect(args.html).toContain("Line one &lt;script&gt;x&lt;/script&gt;<br>Line two");
    expect(args.html).toContain("Hoqëm nga publikimi edhe: <strong>Set &amp; Co</strong>.");
    expect(args.html).toContain("Lexuesit që e kanë blerë e mbajnë.");
    expect(args.html).toContain("Pyetje? Na shkruani te support@librum.al");
    expect(args.html).not.toContain("<script>");
  });

  it("leaves the bundles line out when none were unpublished", async () => {
    await sendBookTakedownEmail("ana@example.com", {
      title: "T",
      reasonLabel: "Tjetër",
      message: "M",
      bundleTitles: [],
    });
    expect(sendMock.mock.calls[0][0].html).not.toContain("Hoqëm nga publikimi edhe");
  });
});

// ADMIN-3-REVIEW (J): approve and send back -- every supplied value is
// escaped in the HTML.
describe("sendBookApprovedEmail / sendBookSentBackEmail", () => {
  beforeEach(() => sendMock.mockClear());

  it("tells the author the book is live, escaping the title", async () => {
    await sendBookApprovedEmail("ana@example.com", { title: "<b>Kënga</b>", bookId: "22222222-2222-4222-8222-222222222222" });
    const args = sendMock.mock.calls[0][0];
    expect(args.to).toBe("ana@example.com");
    expect(args.subject).toBe('Libri juaj "<b>Kënga</b>" u publikua në Librum');
    expect(args.html).toContain("E kontrolluam dhe tani është në Librari.");
    expect(args.html).toContain("&lt;b&gt;Kënga&lt;/b&gt;");
    expect(args.html).not.toContain("<b>Kënga</b>");
    expect(args.html).toContain("/libra/22222222-2222-4222-8222-222222222222");
  });

  it("sends back with the reason label and the escaped message, linking to the dashboard", async () => {
    await sendBookSentBackEmail("ana@example.com", {
      title: "T & Co",
      reasonLabel: "Skedar i gabuar ose i dëmtuar",
      message: "Line one <script>x</script>\nLine two",
    });
    const args = sendMock.mock.calls[0][0];
    expect(args.subject).toBe('Librum jua ktheu "T & Co" për ndryshime');
    expect(args.html).toContain("<strong>T &amp; Co</strong>");
    expect(args.html).toContain("Arsyeja: Skedar i gabuar ose i dëmtuar");
    expect(args.html).toContain("Rregullojeni dhe dërgojeni përsëri për shqyrtim.");
    expect(args.html).toContain("Line one &lt;script&gt;x&lt;/script&gt;<br>Line two");
    expect(args.html).not.toContain("<script>");
    expect(args.html).toContain("/dashboard");
    expect(args.html).toContain("Pyetje? Na shkruani te support@librum.al");
    expect(args.html).not.toContain("mbetet në shitje");
  });

  // BD15 P5b-2: a live book's changes.
  it("approved changes of a live book: their own subject, never 'u publikua', title escaped", async () => {
    await sendBookChangesApprovedEmail("ana@example.com", { title: "<b>Kënga</b>", bookId: "22222222-2222-4222-8222-222222222222" });
    const args = sendMock.mock.calls[0][0];
    expect(args.subject).toBe('Ndryshimet e librit "<b>Kënga</b>" u miratuan');
    expect(args.html).toContain("tani lexuesit shohin versionin e ri");
    expect(args.html).not.toContain("u publikua");
    expect(args.html).toContain("&lt;b&gt;Kënga&lt;/b&gt;");
    expect(args.html).not.toContain("<b>Kënga</b>");
    expect(args.html).toContain("/libra/22222222-2222-4222-8222-222222222222");
  });

  it("a live book's changes sent back: says the book stays on sale as it was", async () => {
    await sendBookSentBackEmail("ana@example.com", { title: "T", reasonLabel: "R", message: "M", live: true });
    expect(sendMock.mock.calls[0][0].html).toContain("Libri juaj mbetet në shitje siç ishte para këtyre ndryshimeve.");
  });

  // BD15 P5b-3a (Renato 11-04): the email names the changes, not the book.
  it("a live book's changes sent back: subject and heading say 'ndryshimet', title escaped", async () => {
    await sendBookSentBackEmail("ana@example.com", { title: "T & Co", reasonLabel: "R", message: "M", live: true });
    const args = sendMock.mock.calls[0][0];
    expect(args.subject).toBe('Librum jua ktheu ndryshimet e "T & Co"');
    expect(args.html).toContain("Librum jua ktheu ndryshimet e librit <strong>T &amp; Co</strong>");
    expect(args.html).not.toContain("jua ktheu librin");
    expect(args.html).toContain("Rregullojini dhe dërgojini përsëri për shqyrtim.");
    expect(args.html).not.toContain("Rregullojeni");
  });
});

// PEOPLE-2: the suspend and lift emails. No reason is ever included.
describe("sendAccountSuspendedEmail / sendAccountSuspensionLiftedEmail", () => {
  beforeEach(() => sendMock.mockClear());

  it("tells the person the account is suspended, without a reason", async () => {
    await sendAccountSuspendedEmail("ana@example.com");
    const args = sendMock.mock.calls[0][0];
    expect(args.to).toBe("ana@example.com");
    expect(args.subject).toBe("Llogaria juaj në Librum u pezullua");
    expect(args.html).toContain("Për momentin nuk mund të hyni në Librum.");
    // Readers get this email too, so the books line is conditional in wording (audit N5).
    expect(args.html).toContain("Nëse publikoni libra në Librum, ata nuk janë në Librari sa kohë që llogaria juaj është e pezulluar.");
    expect(args.html).toContain("Lexuesit që i kanë blerë i mbajnë.");
    expect(args.html).toContain("Pyetje? Na shkruani te support@librum.al");
    expect(args.html).not.toMatch(/arsy/i);
  });

  it("tells the person the account is active again, with a log in link", async () => {
    await sendAccountSuspensionLiftedEmail("ana@example.com");
    const args = sendMock.mock.calls[0][0];
    expect(args.subject).toBe("Llogaria juaj në Librum është sërish aktive");
    expect(args.html).toContain("Mund të hyni përsëri.");
    expect(args.html).toContain("Nëse publikoni libra në Librum, ata janë sërish në Librari, përveç atyre që presin shqyrtim ose që janë hequr.");
    expect(args.html).toMatch(/href="[^"]*\/login">Hyni<\/a>/);
    expect(args.html).toContain("Pyetje? Na shkruani te support@librum.al");
  });
});

// SMALL-FIXES-1 (1a): Resend reports a refused send by RETURNING
// { error }, not by throwing. That is logged as a failure, never thrown,
// and the log carries neither the address nor Resend's message.
describe("sendEmail: a refused send", () => {
  beforeEach(() => sendMock.mockClear());

  it("logs Resend's { error } as a failure, without the address or the message, and does not throw", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMock.mockResolvedValueOnce({
      data: null,
      error: {
        name: "validation_error",
        statusCode: 403,
        message: "You can only send testing emails to your own email address (ana@example.com).",
      },
    } as never);
    try {
      await expect(sendAccountSuspendedEmail("ana@example.com")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(errorSpy.mock.calls[0]);
      expect(logged).toContain("Resend refused it");
      expect(logged).toContain("validation_error");
      expect(logged).toContain("403");
      expect(logged).not.toContain("ana@example.com");
      expect(logged).not.toContain("testing emails");
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs nothing when Resend accepts the email", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await sendAccountSuspendedEmail("ana@example.com");
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("still never throws when the send itself throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    sendMock.mockRejectedValueOnce(new Error("network down"));
    try {
      await expect(sendAccountSuspendedEmail("ana@example.com")).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("the missing-key warning names the subject but never the address", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const key = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      await sendAccountSuspendedEmail("ana@example.com");
      expect(sendMock).not.toHaveBeenCalled();
      const warned = JSON.stringify(warnSpy.mock.calls);
      expect(warned).toContain("Llogaria juaj në Librum u pezullua");
      expect(warned).not.toContain("ana@example.com");
    } finally {
      process.env.RESEND_API_KEY = key;
      warnSpy.mockRestore();
    }
  });
});

// ALBANIAN-12: the purchase and sale emails (not sent today: the live POK
// build sends receipts) are Albanian and escape the title.
describe("sendPurchaseEmails", () => {
  beforeEach(() => sendMock.mockClear());

  it("sends the reader and the author Albanian emails with the escaped title", async () => {
    const { sendPurchaseEmails } = await import("./email");
    const admin = {
      from: () => ({
        select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: { title: "A <b>&</b> B", author_id: "author-1" } }) }) }),
      }),
      auth: { admin: { getUserById: (id: string) => Promise.resolve({ data: { user: { email: `${id}@example.com` } } }) } },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await sendPurchaseEmails(admin, { bookId: "book-1", readerId: "reader-1", amountCents: 19900, currency: "ALL" });

    expect(sendMock).toHaveBeenCalledTimes(2);
    const [reader, author] = sendMock.mock.calls.map(([args]) => args);
    expect(reader.subject).toBe("Konfirmimi i blerjes suaj në Librum");
    expect(reader.html).toContain("Bletë librin <strong>A &lt;b&gt;&amp;&lt;/b&gt; B</strong> për 199 lekë.");
    expect(author.subject).toBe("Bëtë një shitje në Librum");
    expect(author.html).toContain("<strong>A &lt;b&gt;&amp;&lt;/b&gt; B</strong> sapo u shit për 199 lekë.");
    expect(author.html).not.toContain("<b>&</b>");
  });
});
