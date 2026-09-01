import { describe, expect, it, vi, beforeEach } from "vitest";
import Link from "next/link";
import type { ReactElement, ReactNode } from "react";
import type { AuditEventRow, StaffListRow } from "@/lib/types";

// LIBRUM 2.0 ADMIN-1C PART C: proves this page itself calls
// requireStaff("audit.view") -- not merely admin.access -- and that a
// denial stops execution before ANY audit or staff-roster data call.
// Mirrors src/app/admin/(protected)/reports/page.test.ts and
// .../refunds/page.test.ts exactly.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockListAdminAuditEvents = vi.fn();
vi.mock("./actions", () => ({
  listAdminAuditEvents: (params: unknown) => mockListAdminAuditEvents(params),
}));

const mockListStaffMembers = vi.fn();
vi.mock("../staff/actions", () => ({ listStaffMembers: () => mockListStaffMembers() }));

const { default: AdminAuditLogPage } = await import("./page");

// Same plain "walk the returned element tree" technique already
// established by src/app/admin/admin-shell.test.ts -- no DOM rendering,
// this codebase's vitest runs in a plain node environment.
//
// This page composes several of its OWN plain, hook-free helper
// functions (AuditFilterForm, AuditDesktopTable, AuditMobileList) via
// JSX, plus shared hook-free UI primitives (PageHeader, Alert,
// EmptyState) -- none of these are "use client" components, so unlike
// NavLinks/AdminMobileNav (which admin-shell.test.ts's own comment
// explains it deliberately does NOT invoke, since those use real React
// hooks and only work inside an actual render), it's both safe and
// necessary to invoke them directly here: an inert `<Component .../>`
// element descriptor never exposes its own rendered output to a plain
// prop-walk otherwise. expand() below does exactly that, repeatedly,
// until it reaches a host (string-tagged) element or a leaf -- except
// for next/link's own Link, which is deliberately left un-invoked
// (skipped) and instead read via its own href/children props directly,
// the same reasoning admin-shell.test.ts applies to NavLinks.
function expand(node: ReactNode): ReactNode {
  let current: ReactNode = node;
  for (let i = 0; i < 20; i++) {
    if (current === null || current === undefined || typeof current === "boolean") return current;
    if (typeof current === "string" || typeof current === "number") return current;
    if (Array.isArray(current)) return current;
    if (typeof current !== "object") return current;
    const element = current as ReactElement<Record<string, unknown>>;
    if (!("type" in element) || !("props" in element)) return current;
    if (typeof element.type === "function" && element.type !== Link) {
      current = (element.type as (props: Record<string, unknown>) => ReactNode)(element.props);
      continue;
    }
    return current;
  }
  return current;
}

function walkAll(node: ReactNode, visit: (n: ReactNode) => void) {
  const n = expand(node);
  if (n === null || n === undefined || typeof n === "boolean") return;
  if (typeof n === "string" || typeof n === "number") {
    visit(n);
    return;
  }
  if (Array.isArray(n)) {
    n.forEach((child) => walkAll(child, visit));
    return;
  }
  if (typeof n !== "object") return;
  visit(n);
  const element = n as ReactElement<{ children?: ReactNode }>;
  if ("props" in element) {
    walkAll(element.props.children, visit);
  }
}

function collectText(node: ReactNode): string[] {
  const texts: string[] = [];
  walkAll(node, (n) => {
    if (typeof n === "string" || typeof n === "number") texts.push(String(n));
  });
  return texts;
}

function findAllByTagName(node: ReactNode, tagName: string): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  walkAll(node, (n) => {
    if (typeof n === "object" && n !== null && "type" in (n as ReactElement) && (n as ReactElement).type === tagName) {
      found.push(n as ReactElement<Record<string, unknown>>);
    }
  });
  return found;
}

// Collects every `href` prop anywhere in the tree -- Next.js's <Link> is
// a component, not a plain string-tagged host element, so it can't be
// found via findAllByTagName("a") the way <table>/<select>/<th> can;
// this instead finds any element (Link or otherwise) that carries an
// href prop, which is exactly what every Link in this page has.
function collectHrefs(node: ReactNode): string[] {
  const hrefs: string[] = [];
  walkAll(node, (n) => {
    if (typeof n === "object" && n !== null && "props" in (n as ReactElement)) {
      const href = (n as ReactElement<{ href?: string }>).props.href;
      if (typeof href === "string") hrefs.push(href);
    }
  });
  return hrefs;
}

const ROSTER: StaffListRow[] = [
  { user_id: "f0000000-0000-0000-0000-000000000001", display_name: "Owner One", email: "owner@test", role: "owner", created_at: "2026-01-01T00:00:00.000Z" },
];

function makeRow(overrides: Partial<AuditEventRow> = {}): AuditEventRow {
  return {
    id: "e0000000-0000-0000-0000-000000000001",
    actor_id: "f0000000-0000-0000-0000-000000000001",
    actor_display_name: "Owner One",
    action: "staff.added",
    target_type: "staff_members",
    target_id: "f0000000-0000-0000-0000-000000000006",
    metadata: { role: "support" },
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AdminAuditLogPage", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockListAdminAuditEvents.mockReset();
    mockListStaffMembers.mockReset();
  });

  it("calls requireStaff('audit.view') and never queries audit or staff-roster data when denied", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/?denied=audit.view");
    });

    await expect(
      AdminAuditLogPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("audit.view");
    expect(mockListAdminAuditEvents).not.toHaveBeenCalled();
    expect(mockListStaffMembers).not.toHaveBeenCalled();
  });

  it("renders exactly one H1, titled 'Audit log', with operational explanatory copy", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const h1s = findAllByTagName(page, "h1");
    const text = collectText(page).join(" | ");

    expect(h1s).toHaveLength(1);
    expect(collectText(h1s[0])).toContain("Audit log");
    expect(text).toContain("Review consequential administrative actions performed in Librum.");
  });

  it("shows the unfiltered empty state when there are no events and no filters", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("No audit events yet.");
    expect(text).not.toContain("match these filters");
  });

  it("shows the filtered empty state when a filter is active and there are no matching events", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    const page = await AdminAuditLogPage({
      searchParams: Promise.resolve({ action: "staff.added" }),
    });
    const text = collectText(page).join(" | ");

    expect(text).toContain("No audit events match these filters.");
    expect(text).not.toBe("No audit events yet.");
  });

  it("renders a controlled Alert for an RPC error, never a raw DB error string", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({
      ok: false,
      error: "Something went wrong. Please try again.",
    });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Something went wrong. Please try again.");
    expect(text).not.toMatch(/relation|SQLSTATE|postgres|admin_audit_log/i);
  });

  it("shows a controlled inline error for a reversed date range and never calls the RPC", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });

    const page = await AdminAuditLogPage({
      searchParams: Promise.resolve({ from: "2026-02-01", to: "2026-01-01" }),
    });
    const text = collectText(page).join(" | ");

    expect(text).toContain("The start date must be before the end date.");
    expect(mockListAdminAuditEvents).not.toHaveBeenCalled();
  });

  it("renders known rows with friendly action labels, actor names, and linked report/refund targets", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({
      ok: true,
      data: [
        makeRow({
          id: "e1",
          action: "report.resolved",
          target_type: "book_reports",
          target_id: "f0000000-0000-0000-0000-000000000020",
          metadata: { old_status: "open", new_status: "resolved", notes_added: false },
        }),
        makeRow({
          id: "e2",
          action: "refund.review_rejected",
          target_type: "refund_requests",
          target_id: "f0000000-0000-0000-0000-000000000030",
          metadata: { old_status: "requested", new_status: "rejected" },
          actor_display_name: null,
        }),
      ],
    });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");
    const hrefs = collectHrefs(page);

    expect(text).toContain("Report resolved");
    expect(text).toContain("Refund request denied");
    expect(text).toContain("Owner One");
    expect(text).toContain("Former/deleted staff account");
    expect(hrefs).toContain("/admin/reports/f0000000-0000-0000-0000-000000000020");
    expect(hrefs).toContain("/admin/refunds/f0000000-0000-0000-0000-000000000030");
    // staff_members targets never get an individual detail route.
    expect(hrefs.some((h) => h.startsWith("/admin/staff/"))).toBe(false);
  });

  it("never renders raw JSON metadata for any row", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({
      ok: true,
      data: [makeRow({ metadata: { role: "support", secret_internal_field: "abc" } })],
    });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).not.toContain("secret_internal_field");
    expect(text).not.toMatch(/[{}[\]]/);
  });

  it("describes refund.issuance_submitted as submitted, never as completed/succeeded/paid", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({
      ok: true,
      data: [
        makeRow({
          action: "refund.issuance_submitted",
          target_type: "refund_requests",
          target_id: "f0000000-0000-0000-0000-000000000030",
          metadata: { stripe_refund_id: "re_abc123", stripe_status: "pending" },
        }),
      ],
    });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Refund submitted to Stripe");
    expect(text).not.toMatch(/refund (completed|succeeded|paid)/i);
  });

  // ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: lookahead pagination.
  // The page requests AUDIT_DISPLAY_PAGE_SIZE + 1 (26) rows; only when
  // the mock returns 26 does a genuine "more exists" case occur --
  // exactly 25 is now a CONFIRMED end of results, not a maybe.
  function rowsOf(n: number) {
    return Array.from({ length: n }, (_, i) =>
      makeRow({ id: `e${i}`, created_at: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z` }),
    );
  }

  it("requests AUDIT_DISPLAY_PAGE_SIZE + 1 (26) rows from the RPC -- lookahead, not the raw display size", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    await AdminAuditLogPage({ searchParams: Promise.resolve({}) });

    expect(mockListAdminAuditEvents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 26 }),
    );
  });

  it("exactly 25 rows returned: displays all 25, shows NO Next -- the fetch itself already confirms there is nothing more", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: rowsOf(25) });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");
    const hrefs = collectHrefs(page);

    expect(text).not.toContain("Next");
    expect(hrefs.some((h) => h.includes("cursor="))).toBe(false);
  });

  it("26 rows returned (the lookahead row): displays only 25, shows Next, and the 26th row's own id never appears", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    const rows = rowsOf(26);
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: rows });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");
    const hrefs = collectHrefs(page);

    expect(text).toContain("Next");
    expect(hrefs.some((h) => h.startsWith("/admin/audit?cursor="))).toBe(true);
    // The 26th row (index 25, "e25") is lookahead evidence only and must
    // never be rendered as a visible row.
    expect(text).not.toContain("e25");
  });

  it("shows no Next link when fewer than the page limit is returned", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [makeRow()] });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const hrefs = collectHrefs(page);

    expect(hrefs.some((h) => h.includes("cursor="))).toBe(false);
  });

  it("Next preserves the active filters alongside the new cursor", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: rowsOf(26) });

    const page = await AdminAuditLogPage({
      searchParams: Promise.resolve({ action: "staff.added" }),
    });
    const hrefs = collectHrefs(page);
    const nextHref = hrefs.find((h) => h.includes("cursor="));

    expect(nextHref).toContain("action=staff.added");
  });

  it("shows a Clear filters link back to the bare route when a filter is active, and omits it otherwise", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    const filtered = await AdminAuditLogPage({
      searchParams: Promise.resolve({ action: "staff.added" }),
    });
    expect(collectText(filtered).join(" | ")).toContain("Clear filters");
    expect(collectHrefs(filtered)).toContain("/admin/audit");

    const unfiltered = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    expect(collectText(unfiltered).join(" | ")).not.toContain("Clear filters");
  });

  it("passes only user_id/display_name-shaped filter options through the roster -- never renders staff email", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({
      ok: true,
      data: [
        {
          user_id: "f0000000-0000-0000-0000-000000000002",
          display_name: "Admin Person",
          email: "admin-person@example.com",
          role: "admin",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const text = collectText(page).join(" | ");

    expect(text).toContain("Admin Person");
    expect(text).not.toContain("admin-person@example.com");
  });

  // ADMIN-1C Part C FINAL PRE-COMMIT UI CORRECTION: the actor filter's
  // synthetic-option fix -- a valid ?actor=<uuid> not present in the
  // current roster must still show as a real, selected option, not
  // silently render as though "All actors" were picked.
  describe("actor filter: former-staff synthetic option", () => {
    function findSelectById(node: ReactNode, id: string) {
      return findAllByTagName(node, "select").find((s) => s.props.id === id);
    }

    // select's children mix a literal <option> with {actorOptions.map(...)}
    // -- a nested array, not a flat one -- so this walks the WHOLE
    // subtree for <option> tags rather than only inspecting one level of
    // props.children.
    function optionEntries(select: ReactElement<Record<string, unknown>> | undefined) {
      if (!select) return [];
      return findAllByTagName(select, "option").map((opt) => ({
        value: opt.props.value as string,
        text: collectText(opt).join(""),
      }));
    }

    const CURRENT_STAFF_ID = "f0000000-0000-0000-0000-000000000002";
    const FORMER_STAFF_ID = "f0000000-0000-0000-0000-000000000099";
    const staffRoster: StaffListRow[] = [
      {
        user_id: CURRENT_STAFF_ID,
        display_name: "Current Staffer",
        email: "current@example.com",
        role: "admin",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];

    it("current-staff actor: a normal named option is selected", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      mockListStaffMembers.mockResolvedValue({ ok: true, data: staffRoster });
      mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

      const page = await AdminAuditLogPage({
        searchParams: Promise.resolve({ actor: CURRENT_STAFF_ID }),
      });
      const select = findSelectById(page, "audit-actor");
      const options = optionEntries(select);

      expect(select?.props.defaultValue).toBe(CURRENT_STAFF_ID);
      expect(options).toContainEqual({ value: CURRENT_STAFF_ID, text: "Current Staffer" });
      expect(options.some((o) => o.text.includes("Former/deleted"))).toBe(false);
    });

    it("former/unknown valid UUID: a synthetic option is added and IS the one the select is set to", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      mockListStaffMembers.mockResolvedValue({ ok: true, data: staffRoster });
      mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

      const page = await AdminAuditLogPage({
        searchParams: Promise.resolve({ actor: FORMER_STAFF_ID }),
      });
      const select = findSelectById(page, "audit-actor");
      const options = optionEntries(select);

      // The visible control state (defaultValue) matches the active
      // query (?actor=FORMER_STAFF_ID) exactly -- and there IS a real
      // option with that same value, unlike the prior bug.
      expect(select?.props.defaultValue).toBe(FORMER_STAFF_ID);
      const synthetic = options.find((o) => o.value === FORMER_STAFF_ID);
      expect(synthetic).toBeTruthy();
      expect(synthetic?.text).toContain("Former/deleted staff account");
      expect(synthetic?.text).toContain("f0000000");
    });

    it("the synthetic option's rendered text never contains an email address", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      mockListStaffMembers.mockResolvedValue({ ok: true, data: staffRoster });
      mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

      const page = await AdminAuditLogPage({
        searchParams: Promise.resolve({ actor: FORMER_STAFF_ID }),
      });
      const text = collectText(page).join(" | ");

      expect(text).not.toContain("@");
      expect(text).not.toContain("current@example.com");
    });

    it("invalid actor UUID: no actor filter is applied, and no synthetic option is fabricated for it", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      mockListStaffMembers.mockResolvedValue({ ok: true, data: staffRoster });
      mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

      const page = await AdminAuditLogPage({
        searchParams: Promise.resolve({ actor: "not-a-uuid" }),
      });

      expect(mockListAdminAuditEvents).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: null }),
      );
      const select = findSelectById(page, "audit-actor");
      const options = optionEntries(select);
      expect(options.some((o) => o.value === "not-a-uuid")).toBe(false);
    });

    it("no active actor filter: only real roster options are present, no synthetic option", async () => {
      mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
      mockListStaffMembers.mockResolvedValue({ ok: true, data: staffRoster });
      mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

      const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
      const select = findSelectById(page, "audit-actor");
      const options = optionEntries(select);

      expect(options.some((o) => o.text.includes("Former/deleted"))).toBe(false);
      expect(select?.props.defaultValue).toBe("");
    });
  });

  it("renders both a desktop table and a mobile card list from the same rows (responsive structure)", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [makeRow()] });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const tables = findAllByTagName(page, "table");
    const uls = findAllByTagName(page, "ul");

    expect(tables).toHaveLength(1);
    // The table's containing div must be hidden by default and only
    // shown at md: -- never a bare, always-visible wide table that could
    // force horizontal overflow on a narrow viewport.
    const desktopWrapper = findAllByTagName(page, "div").find((d) =>
      typeof d.props.className === "string" &&
      d.props.className.includes("hidden") &&
      d.props.className.includes("md:block") &&
      d.props.className.includes("overflow-x-auto"),
    );
    expect(desktopWrapper).toBeTruthy();

    const mobileList = uls.find(
      (ul) => typeof ul.props.className === "string" && ul.props.className.includes("md:hidden"),
    );
    expect(mobileList).toBeTruthy();
  });

  it("every filter select/input has an associated label", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "u1", role: "owner" });
    mockListStaffMembers.mockResolvedValue({ ok: true, data: ROSTER });
    mockListAdminAuditEvents.mockResolvedValue({ ok: true, data: [] });

    const page = await AdminAuditLogPage({ searchParams: Promise.resolve({}) });
    const labels = findAllByTagName(page, "label");
    const controls = [
      ...findAllByTagName(page, "select"),
      ...findAllByTagName(page, "input"),
    ];
    const labelFor = new Set(labels.map((l) => l.props.htmlFor));

    for (const control of controls) {
      expect(labelFor.has(control.props.id)).toBe(true);
    }
  });

  it("never imports createAdminClient/the service-role client", async () => {
    // Matches actual import statements only (same technique as
    // ./actions.test.ts's own equivalent check) -- this file's own
    // documentation comments mention "createAdminClient" by name to
    // explain what's deliberately NOT used, which a bare substring match
    // would misfire on.
    const { readFileSync } = await import("fs");
    const path = await import("path");
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toMatch(/import\s*\{[^}]*createAdminClient[^}]*\}/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/admin"/);
    expect(source).not.toMatch(/from\s*"@\/lib\/supabase\/server"/);
  });
});
