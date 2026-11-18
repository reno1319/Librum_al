import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_DELETIONS_PER_RUN, ACCOUNT_DELETIONS_SCAN_LIMIT, runDueAccountDeletions } from "@/lib/account-deletion";
import { LEAVE_REASONS, isDayParam, parseLeaveReason, tiranaDay } from "@/lib/account-deletion-reasons";
import { accountDeletionRequestedEmail } from "@/lib/email";

// DEL: the daily job's batch (runDueAccountDeletions). The deletion of
// one account (deleteAccountNow) is covered case by case in
// account-deletion.book-storage.test.ts and account-deletion.avatar.test.ts;
// here every claimed account is a staff member, so deleteAccountNow stops
// at its first read and the batch logic is what is tested.

const NOW = new Date("2026-12-18T03:30:00.000Z");

let dueResult: { data: unknown; error: unknown };
let claimResults: Record<string, { data: unknown; error: unknown }>;
let listQuery: Record<string, unknown>;
let claimed: string[];
let staffReads: string[];
let deleteUserCalls: number;

function service() {
  return {
    from: (table: string) => {
      if (table === "account_deletion_requests") {
        return {
          select: (columns: string) => {
            listQuery.columns = columns;
            return {
              lte: (column: string, value: string) => {
                listQuery.lte = [column, value];
                const orders: unknown[] = [];
                listQuery.order = orders;
                const chain = {
                  order: (oc: string, opts: unknown) => {
                    orders.push([oc, opts]);
                    return chain;
                  },
                  limit: (n: number) => {
                    listQuery.limit = n;
                    return { returns: async () => dueResult };
                  },
                };
                return chain;
              },
            };
          },
        };
      }
      if (table === "staff_members") {
        return {
          select: () => ({
            eq: (_c: string, id: string) => ({
              maybeSingle: async () => {
                staffReads.push(id);
                return { data: { role: "support" }, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    rpc: async (name: string, args: { p_user_id: string }) => {
      expect(name).toBe("account_deletion_claim");
      claimed.push(args.p_user_id);
      return claimResults[args.p_user_id] ?? { data: true, error: null };
    },
    auth: { admin: { deleteUser: async () => { deleteUserCalls += 1; return { error: null }; } } },
  };
}

beforeEach(() => {
  dueResult = { data: [], error: null };
  claimResults = {};
  listQuery = {};
  claimed = [];
  staffReads = [];
  deleteUserCalls = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runDueAccountDeletions", () => {
  it("lists only accounts whose 30 days are over: never tried first, then oldest attempt, then oldest date", async () => {
    const result = await runDueAccountDeletions(service() as never, NOW);
    expect(result).toEqual({ ok: true, counts: expect.objectContaining({ deleted: 0, not_claimed: 0 }) });
    expect(listQuery).toEqual({
      columns: "user_id",
      lte: ["delete_after", NOW.toISOString()],
      order: [
        ["processing_at", { ascending: true, nullsFirst: true }],
        ["delete_after", { ascending: true }],
      ],
      limit: ACCOUNT_DELETIONS_SCAN_LIMIT,
    });
    expect(ACCOUNT_DELETIONS_PER_RUN).toBe(20);
    expect(ACCOUNT_DELETIONS_SCAN_LIMIT).toBe(100);
  });

  it("AUDIT S1: accounts the claim refuses don't use up the run; at most 20 are worked on", async () => {
    const refused = Array.from({ length: 25 }, (_, i) => ({ user_id: `refused-${i}` }));
    const due = Array.from({ length: 30 }, (_, i) => ({ user_id: `due-${i}` }));
    dueResult = { data: [...refused, ...due], error: null };
    for (const r of refused) claimResults[r.user_id] = { data: false, error: null };
    const result = await runDueAccountDeletions(service() as never, NOW);
    expect(staffReads).toEqual(due.slice(0, 20).map((r) => r.user_id));
    expect(claimed).toHaveLength(45);
    expect(result).toEqual({ ok: true, counts: expect.objectContaining({ not_claimed: 25, staff: 20 }) });
  });

  it("a failed list deletes nothing", async () => {
    dueResult = { data: null, error: { message: "x" } };
    expect(await runDueAccountDeletions(service() as never, NOW)).toEqual({ ok: false });
    expect(claimed).toEqual([]);
  });

  it("claims each account before touching it; an unclaimed one (restored, not due, or a claim error) is skipped", async () => {
    dueResult = { data: [{ user_id: "a" }, { user_id: "b" }, { user_id: "c" }], error: null };
    claimResults = {
      a: { data: false, error: null },
      b: { data: null, error: { message: "x" } },
    };
    const result = await runDueAccountDeletions(service() as never, NOW);
    expect(claimed).toEqual(["a", "b", "c"]);
    expect(staffReads).toEqual(["c"]);
    expect(result).toEqual({ ok: true, counts: expect.objectContaining({ not_claimed: 2, staff: 1, deleted: 0 }) });
    expect(deleteUserCalls).toBe(0);
  });

  it("logs counts only, never an account id", async () => {
    dueResult = { data: [{ user_id: "secret-user-id" }], error: null };
    await runDueAccountDeletions(service() as never, NOW);
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[][] } }).mock.calls);
    expect(logged).not.toContain("secret-user-id");
  });
});

describe("leave reasons and dates", () => {
  it("accepts exactly the five codes the database accepts", () => {
    expect(LEAVE_REASONS.map((r) => r.code)).toEqual(["not_using", "no_books", "privacy", "other_account", "other"]);
    for (const r of LEAVE_REASONS) expect(parseLeaveReason(r.code)).toBe(r.code);
    for (const bad of [null, undefined, "", "NOT_USING", "other ", 1]) expect(parseLeaveReason(bad)).toBeNull();
  });

  it("tiranaDay gives the Tirana calendar day", () => {
    expect(tiranaDay("2026-12-18T10:00:00.000Z")).toBe("2026-12-18");
    // 23:30 UTC is already the next day in Tirana (UTC+1 in winter).
    expect(tiranaDay("2026-12-18T23:30:00.000Z")).toBe("2026-12-19");
    expect(tiranaDay("not a date")).toBeNull();
  });

  it("isDayParam accepts only a real YYYY-MM-DD", () => {
    expect(isDayParam("2026-12-18")).toBe(true);
    for (const bad of ["2026-13-40", "18.12.2026", "2026-12-18<script>", "", null, ["2026-12-18"]]) {
      expect(isDayParam(bad)).toBe(false);
    }
  });
});

describe("accountDeletionRequestedEmail (del5 a)", () => {
  it("names both dates and the Restore button, with the password line only for a password account", () => {
    const withPassword = accountDeletionRequestedEmail({ requestedOn: "18 nëntor 2026", deleteOn: "18 dhjetor 2026", hasPassword: true });
    expect(withPassword.subject).toBe("Kërkesa për fshirjen e llogarisë suaj në Librum");
    expect(withPassword.html).toContain("18 nëntor 2026");
    expect(withPassword.html).toContain("<strong>18 dhjetor 2026</strong>");
    expect(withPassword.html).toContain("«Riktheni llogarinë time»");
    expect(withPassword.html).toContain("ndryshoni fjalëkalimin");
    expect(withPassword.html).not.toContain("href=");

    const google = accountDeletionRequestedEmail({ requestedOn: "a", deleteOn: "b", hasPassword: false });
    expect(google.html).not.toContain("fjalëkalim");
  });

  it("escapes the dates", () => {
    const { html } = accountDeletionRequestedEmail({ requestedOn: "<b>", deleteOn: "&", hasPassword: false });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&amp;");
  });
});
