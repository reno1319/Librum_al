import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// PEN-NAMES-2: static guards for the private-reads change. After the
// contract the base catalog tables are own-row and every public read goes
// through a definer view with no account column. These guards keep new
// code from quietly reading a base table for public data (which would
// show nothing after the contract, or worse, show an account id before
// it), from selecting author_id from a view, or from handing a full row
// type to a client component.

const SRC = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(SRC, file).split(sep).join("/");

// Comments are stripped so a guard looks at code only. Line comments are
// removed only where `//` starts the comment (beginning of line or after
// whitespace), so a URL inside a string survives.
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

// Each `.from("<table>")` call with the text of its chain, up to the end
// of the statement or the next `.from(`.
function chains(source: string, table: string): string[] {
  const out: string[] = [];
  const needle = `.from("${table}")`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    const rest = source.slice(at + needle.length);
    const stops = [rest.indexOf(";"), rest.indexOf(".from(")].filter((i) => i !== -1);
    out.push(rest.slice(0, stops.length ? Math.min(...stops) : 600));
    at = source.indexOf(needle, at + needle.length);
  }
  return out;
}

const OWN_ROW_EQ = /\.eq\("(author_id|reader_id)",\s*(user\.id|userId)\)/;

// src/lib is guarded too: shared read helpers (Librum's choice, author
// series) feed public pages. email.ts is left out on purpose: it is given
// the service-role client by its callers (webhooks and server actions)
// to build transactional emails, and it never renders a public page.
const PUBLIC_FILES = [
  ...walk(join(SRC, "app", "(public)")),
  ...walk(join(SRC, "components")),
  ...walk(join(SRC, "lib")),
].filter((f) => !rel(f).startsWith("app/(public)/dashboard/") && rel(f) !== "lib/email.ts");

// The own-row checks the brief lists (isAuthor and "your review"), plus
// deleteAccount's own-books read. Each must carry an own-row filter.
const PUBLIC_BASE_READS: Record<string, string[]> = {
  "app/(public)/books/[id]/page.tsx": ["books", "reviews"],
  "app/(public)/books/[id]/actions.ts": ["books"],
  "app/(public)/bundles/[id]/page.tsx": ["bundles"],
  "app/(public)/account/actions.ts": ["books"],
  // The author's own book for the rights declaration (16a).
  "lib/book-rights.ts": ["books"],
  // ADMIN-3-REVIEW (N3): the retention cleanup re-reads the book's
  // current file_path, filtered by id AND the author id its callers pass
  // (always the authenticated user's own id, or the review's author on
  // the staff side).
  "lib/book-reviews.ts": ["books"],
};
// A helper that takes the author id as a parameter names it so.
const OWN_ROW_EQ_BY_FILE: Record<string, RegExp> = {
  "lib/book-reviews.ts": /\.eq\("author_id",\s*params\.authorId\)/,
};

describe("PEN-NAMES-2 static guard: public surfaces read the views, not the base tables", () => {
  it("finds the files it guards", () => {
    expect(PUBLIC_FILES.length).toBeGreaterThan(50);
    for (const file of Object.keys(PUBLIC_BASE_READS)) {
      expect(PUBLIC_FILES.map(rel)).toContain(file);
    }
  });

  it.each(PUBLIC_FILES.map((f) => [rel(f), f]))(
    "%s reads books/series/bundles/reviews only through an own-row check",
    (name, file) => {
      const source = code(file);
      for (const table of ["books", "series", "bundles", "reviews"]) {
        // Writes (an upsert of the reader's own review) are not reads.
        const reads = chains(source, table).filter((c) => c.includes(".select("));
        if (reads.length === 0) continue;
        expect(PUBLIC_BASE_READS[name] ?? [], `${name} reads base ${table}`).toContain(table);
        for (const chain of reads) expect(chain).toMatch(OWN_ROW_EQ_BY_FILE[name] ?? OWN_ROW_EQ);
      }
    },
  );

  it("no embed of a base catalog table in a public select", () => {
    for (const file of PUBLIC_FILES) {
      const source = code(file);
      // `books(`, `series(`, `bundles(`, `reviews(` inside a select string,
      // not aliased to a public_* view.
      expect(source, rel(file)).not.toMatch(/\.select\(\s*"[^"]*(?<![\w:])(books|series|bundles|reviews)\(/);
      expect(source, rel(file)).not.toMatch(/\.select\(\s*"[^"]*:(books|series|bundles|reviews)\(/);
    }
  });
});

const ADMIN_FILES = walk(join(SRC, "app", "admin"));

describe("PEN-NAMES-2 static guard: staff pages (MF2, MF3)", () => {
  // ADMIN-2-TAKEDOWN: the report pages and Today read book titles through
  // books/admin-book-reads.ts, and the staff Books section reads books
  // itself -- every one with the service-role client after
  // requireStaff("reports.view" | "reports.resolve"), so drafts and
  // taken-down books show (all of these roles hold reports.resolve, 13a).
  const BOOKS_ALLOWED = [
    "app/admin/(protected)/reports/[id]/page.tsx",
    "app/admin/(protected)/books/page.tsx",
    "app/admin/(protected)/books/[id]/page.tsx",
    "app/admin/(protected)/books/actions.ts",
    "app/admin/(protected)/books/admin-book-reads.ts",
    // ADMIN-3-REVIEW (H): the staff file link checks the book's current
    // file against the pending snapshot, after requireStaff("books.review").
    "app/admin/(protected)/books/[id]/file/route.ts",
    // PEOPLE-1 (10a): a person's page lists their books, after
    // requireStaff("people.view").
    "app/admin/(protected)/people/[id]/page.tsx",
  ];
  // The shared helper is gated by its callers; each caller is listed.
  const BOOK_READ_HELPER = "app/admin/(protected)/books/admin-book-reads.ts";
  // ADMIN-3-REVIEW: the review actions read the rights state through it.
  const HELPER_CALLERS = [
    "app/admin/(protected)/page.tsx",
    "app/admin/(protected)/reports/page.tsx",
    "app/admin/(protected)/books/page.tsx",
    "app/admin/(protected)/books/actions.ts",
  ];

  it("a base books read (from or embed) appears only on the report and staff Books pages", () => {
    const readers = ADMIN_FILES.filter((file) => {
      const source = code(file);
      return source.includes('.from("books")') || /\.select\(\s*"[^"]*(?<![\w:])books\(/.test(source);
    }).map(rel);
    expect(readers.sort()).toEqual([...BOOKS_ALLOWED].sort());
  });

  it("each staff books reader is gated by requireStaff, the shared helper by its callers (ADMIN-2)", () => {
    for (const name of BOOKS_ALLOWED) {
      if (name === BOOK_READ_HELPER) continue;
      expect(code(join(SRC, name)), name).toMatch(/requireStaff\("(reports\.view|reports\.resolve|books\.review|people\.view)"\)/);
    }
    const callers = ADMIN_FILES.filter((file) => code(file).includes("/admin-book-reads\"")).map(rel);
    expect(callers.sort()).toEqual([...HELPER_CALLERS].sort());
    for (const name of callers) expect(code(join(SRC, name)), name).toMatch(/requireStaff\(/);
    expect(readFileSync(join(SRC, BOOK_READ_HELPER), "utf8")).toMatch(/^import "server-only";/);
  });

  it("profiles is read only on reports.view / staff.view pages, plus admin-shell's own-row read (O-b)", () => {
    const readers = ADMIN_FILES.filter((file) => {
      const source = code(file);
      return source.includes('.from("profiles")') || /\.select\(\s*"[^"]*(?<![\w:])profiles[(!]/.test(source);
    });
    for (const file of readers) {
      const name = rel(file);
      const source = code(file);
      if (name === "app/admin/admin-shell.tsx") {
        const [chain] = chains(source, "profiles");
        expect(chain).toMatch(/\.eq\("id",\s*userId\)/);
        expect(chains(source, "profiles")).toHaveLength(1);
        continue;
      }
      expect(source, name).toMatch(/requireStaff\("(reports\.view|staff\.view)"\)/);
    }
  });

  it("the support pages use staff_profile_display_names and read no profiles", () => {
    for (const name of [
      "app/admin/(protected)/page.tsx",
      "app/admin/(protected)/refunds/page.tsx",
      "app/admin/(protected)/refunds/[id]/page.tsx",
    ]) {
      const source = code(join(SRC, name));
      expect(source, name).toContain("loadStaffDisplayNames(");
      expect(source, name).not.toContain('.from("profiles")');
    }
  });
});

const ALL_FILES = walk(SRC);

describe("PEN-NAMES-2 static guard: no account column in a public read", () => {
  it("no select on a public_* view asks for author_id", () => {
    for (const file of ALL_FILES) {
      const source = code(file);
      for (const view of ["public_books", "public_bundles", "public_series", "public_reviews", "public_pen_names"]) {
        for (const chain of chains(source, view)) {
          expect(chain, `${rel(file)} ${view}`).not.toMatch(/\.select\(\s*"[^"]*\b(author_id|reader_id|file_path)\b/);
        }
        expect(source, rel(file)).not.toMatch(new RegExp(`${view}\\([^)]*\\b(author_id|reader_id|file_path)\\b`));
      }
    }
  });

  it('nothing filters a shelf with .neq("author_id" (L15: leave out a pen name, not an account)', () => {
    for (const file of ALL_FILES) {
      expect(code(file), rel(file)).not.toContain('.neq("author_id"');
    }
  });
});

describe("PEN-NAMES-2 static guard: client components get no row types", () => {
  const ROW_TYPES = /\b(Book|Bundle|Series|Review|Profile|OwnPenName)\b/;
  const clientFiles = ALL_FILES.filter((f) => /^\s*["']use client["']/.test(readFileSync(f, "utf8")));

  it("finds client components", () => {
    expect(clientFiles.length).toBeGreaterThan(10);
  });

  it("no public client component imports a base row type", () => {
    for (const file of clientFiles) {
      const name = rel(file);
      if (name.startsWith("app/(public)/dashboard/") || name.startsWith("app/admin/")) continue;
      const imports = code(file).match(/import\s+(type\s+)?\{[^}]*\}\s+from\s+"@\/lib\/(types|pen-names)"/g) ?? [];
      for (const line of imports) expect(line, name).not.toMatch(ROW_TYPES);
    }
  });
});

describe("PEN-NAMES-2 static guard: author sales read the 23b views (23b)", () => {
  it("author sales never read purchases or bundle_checkout_snapshots directly", () => {
    for (const name of [
      "app/(public)/dashboard/dashboard-sales.ts",
      "app/(public)/dashboard/sales/page.tsx",
      "app/(public)/dashboard/page.tsx",
      "app/(public)/dashboard/books/actions.ts",
    ]) {
      const source = code(join(SRC, name));
      expect(source, name).not.toContain('.from("purchases")');
      expect(source, name).not.toContain('.from("bundle_checkout_snapshots")');
    }
  });
});

// Audit PEN-2 r1 F1: authenticated holds no INSERT on books or bundles
// (expand E5, E5b), so no code may insert either with any client but the
// trusted catalog writer -- books through its insert, bundles only through
// create_bundle_with_membership.
describe("PEN-NAMES-2 static guard: no direct bundle insert (F1)", () => {
  it("nothing in src inserts or upserts bundles with .from(\"bundles\")", () => {
    for (const file of ALL_FILES) {
      if (/\.test\.tsx?$/.test(file) || file.endsWith("test-double.ts")) continue;
      for (const chain of chains(code(file), "bundles")) {
        expect(chain, rel(file)).not.toMatch(/^\s*\.(insert|upsert)\(/);
      }
    }
  });

  it("createBundle creates through create_bundle_with_membership on the trusted writer", () => {
    const source = code(join(SRC, "app/(public)/dashboard/bundles/actions.ts"));
    expect(source).toMatch(/catalogWriter\.rpc\("create_bundle_with_membership"/);
  });

  it("the guard sees a direct insert (mutation check)", () => {
    expect(chains('supabase.from("bundles").insert({ title });', "bundles")[0]).toMatch(/^\s*\.(insert|upsert)\(/);
  });
});
