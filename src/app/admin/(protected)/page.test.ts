import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import type { AuditEventRow, StaffRole } from "@/lib/types";
import { PROTECTED_STAGING_BRANCH, STAGING_SUPABASE_URL } from "@/lib/protected-staging";

// ADMIN-1 (A2 look): the "Today" page. The page is an async Server
// Component, so its returned element tree is rendered to static HTML
// here (no DOM in vitest's node environment) and the HTML is checked
// per role: which tiles, to-do rows and activity show, that only the
// queries a role may run are run, and that no amount ever appears.
const mockRequireStaff = vi.fn(
  (permission: string): Promise<{ userId: string; role: StaffRole }> => {
    void permission;
    return Promise.resolve({ userId: "staff-1", role: "owner" });
  },
);
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

type Rows = { data: unknown[] | null; error: { message: string } | null };
let tableRows: Record<string, Rows> = {};
const queries: { table: string; select: string; filters: [string, unknown][]; order?: [string, unknown] }[] = [];

function makeQuery(table: string) {
  const q = { table, select: "", filters: [] as [string, unknown][], order: undefined as [string, unknown] | undefined };
  queries.push(q);
  const result = () => Promise.resolve(tableRows[table] ?? { data: [], error: null });
  const chain = {
    select(cols: string) {
      q.select = cols;
      return chain;
    },
    eq(col: string, value: unknown) {
      q.filters.push([col, value]);
      return chain;
    },
    in(col: string, value: unknown) {
      q.filters.push([`${col} in`, value]);
      return result();
    },
    order(col: string, opts: unknown) {
      q.order = [col, opts];
      return chain;
    },
    returns() {
      return result();
    },
  };
  return chain;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => Promise.resolve({ from: (table: string) => makeQuery(table) }),
}));

const mockListAudit = vi.fn(
  (params: { limit?: number }): Promise<{ ok: true; data: AuditEventRow[] } | { ok: false; error: string }> => {
    void params;
    return Promise.resolve({ ok: true, data: [] });
  },
);
vi.mock("./audit/actions", () => ({ listAdminAuditEvents: (p: { limit?: number }) => mockListAudit(p) }));

const { default: AdminPage } = await import("./page");

async function renderAs(role: StaffRole): Promise<string> {
  mockRequireStaff.mockResolvedValueOnce({ userId: "staff-1", role });
  return renderToStaticMarkup((await AdminPage()) as ReactElement);
}

const OPEN_REPORT = { id: "rep-1", created_at: "2026-10-10T08:00:00Z", books: { title: "Kënga e fundit" } };
const WAITING_REFUND = { id: "ref-1", reader_id: "reader-1", requested_at: "2026-10-12T08:00:00Z" };

describe("AdminPage (Today)", () => {
  beforeEach(() => {
    mockRequireStaff.mockClear();
    mockListAudit.mockClear();
    queries.length = 0;
    tableRows = {};
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T09:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("gates on requireStaff('admin.access')", async () => {
    await renderAs("admin");
    expect(mockRequireStaff).toHaveBeenCalledWith("admin.access");
  });

  it("shows today's date (Tirana) and the Today heading", async () => {
    const html = await renderAs("owner");
    expect(html).toContain(">Monday 19 October<");
    expect(html).toMatch(/<h1[^>]*>Today<\/h1>/);
  });

  it("status chips: both Off outside protected staging, labels only", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
    vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_checkout_test");
    const html = await renderAs("moderator");
    expect(html).toContain("Paid publishing: <strong>Off</strong>");
    expect(html).toContain("Paid checkout: <strong>Off</strong>");
    expect(html).not.toContain("controlled_staging");
    expect(html).not.toContain("environment_not_permitted");
    expect(html).not.toContain("POK");
  });

  it("status chips: each follows its own resolver's .allowed on protected staging", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", PROTECTED_STAGING_BRANCH);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STAGING_SUPABASE_URL);
    vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
    vi.stubEnv("PAID_CHECKOUT_MODE", "");
    const html = await renderAs("support");
    expect(html).toContain("Paid publishing: <strong>On</strong>");
    expect(html).toContain("Paid checkout: <strong>Off</strong>");
    expect(html).not.toContain("controlled_staging");
    expect(html).not.toContain("mode_absent");
  });

  it("owner: both tiles with counts, the merged To do list oldest first, and recent activity", async () => {
    tableRows = {
      book_reports: { data: [OPEN_REPORT], error: null },
      refund_requests: { data: [WAITING_REFUND], error: null },
      profiles: { data: [{ id: "reader-1", display_name: "Arta" }], error: null },
    };
    mockListAudit.mockResolvedValueOnce({
      ok: true,
      data: [
        {
          id: "ev-1",
          actor_id: "staff-1",
          actor_display_name: "Renato",
          action: "report.resolved",
          target_type: "book_reports",
          target_id: "rep-0",
          metadata: {},
          created_at: "2026-10-19T07:41:00Z",
        },
      ],
    });
    const html = await renderAs("owner");

    expect(html).toMatch(/href="\/admin\/reports"[^>]*>.*Open book reports.*>1<.*Oldest: 10 Oct 2026/);
    expect(html).toMatch(/href="\/admin\/refunds"[^>]*>.*Refund requests waiting.*>1<.*Oldest: 12 Oct 2026/);

    const reportRow = html.indexOf("Report on “Kënga e fundit”");
    const refundRow = html.indexOf("Refund request from Arta");
    expect(reportRow).toBeGreaterThan(-1);
    expect(refundRow).toBeGreaterThan(reportRow);
    expect(html).toContain('href="/admin/reports/rep-1"');
    expect(html).toContain('href="/admin/refunds/ref-1"');

    expect(mockListAudit).toHaveBeenCalledWith({ limit: 5 });
    expect(html).toContain("19 Oct, 09:41");
    expect(html).toContain("Renato: Report resolved");
    expect(html).toContain('href="/admin/audit"');
    expect(html).toContain("Full audit log");
  });

  it("counts reports with status open and refunds with status requested only, oldest first, selecting no amount", async () => {
    await renderAs("owner");
    const reports = queries.find((q) => q.table === "book_reports");
    const refunds = queries.find((q) => q.table === "refund_requests");
    expect(reports?.filters).toEqual([["status", "open"]]);
    expect(reports?.order).toEqual(["created_at", { ascending: true }]);
    expect(refunds?.filters).toEqual([["status", "requested"]]);
    expect(refunds?.order).toEqual(["requested_at", { ascending: true }]);
    for (const q of queries) expect(q.select).not.toMatch(/amount|price|cents/);
  });

  it("moderator: only the reports tile; no refunds query, no activity", async () => {
    tableRows = { book_reports: { data: [OPEN_REPORT], error: null } };
    const html = await renderAs("moderator");
    expect(html).toContain("Open book reports");
    expect(html).not.toContain("Refund requests waiting");
    expect(html).not.toContain("Recent activity");
    expect(queries.map((q) => q.table)).not.toContain("refund_requests");
    expect(mockListAudit).not.toHaveBeenCalled();
  });

  it("support: only the refunds tile; no reports query, no activity", async () => {
    tableRows = {
      refund_requests: { data: [WAITING_REFUND], error: null },
      profiles: { data: [], error: null },
    };
    const html = await renderAs("support");
    expect(html).toContain("Refund requests waiting");
    expect(html).toContain("Refund request from an unknown reader");
    expect(html).not.toContain("Open book reports");
    expect(html).not.toContain("Recent activity");
    expect(queries.map((q) => q.table)).not.toContain("book_reports");
    expect(mockListAudit).not.toHaveBeenCalled();
  });

  it("editor: no tiles, Nothing waiting, no activity, and no queue queries at all", async () => {
    const html = await renderAs("editor");
    expect(html).not.toContain('aria-label="Waiting"');
    expect(html).toContain("Nothing waiting.");
    expect(html).not.toContain("Recent activity");
    expect(queries).toHaveLength(0);
    expect(mockListAudit).not.toHaveBeenCalled();
  });

  it("empty queues: tiles say 0 and Nothing waiting; To do says Nothing waiting.", async () => {
    const html = await renderAs("admin");
    expect(html).toMatch(/Open book reports.*>0<.*Nothing waiting/);
    expect(html).toMatch(/Refund requests waiting.*>0<.*Nothing waiting/);
    expect(html).toContain("Nothing waiting.");
    expect(html).toContain("No admin actions yet.");
  });

  it("a failed query shows a dash and a warning, never a false zero", async () => {
    tableRows = { book_reports: { data: null, error: { message: "boom" } } };
    const html = await renderAs("moderator");
    expect(html).toMatch(/Open book reports.*>—<.*Couldn’t load/);
    expect(html).toContain("Some items couldn’t be loaded.");
    expect(html).not.toContain("boom");
  });

  it("caps the To do list at five rows", async () => {
    tableRows = {
      book_reports: {
        data: Array.from({ length: 7 }, (_, n) => ({
          id: `r${n}`,
          created_at: `2026-10-0${n + 1}T08:00:00Z`,
          books: { title: `Book ${n}` },
        })),
        error: null,
      },
    };
    const html = await renderAs("moderator");
    expect(html.match(/>Review report</g)).toHaveLength(5);
    expect(html).toMatch(/Open book reports.*>7</);
  });
});
