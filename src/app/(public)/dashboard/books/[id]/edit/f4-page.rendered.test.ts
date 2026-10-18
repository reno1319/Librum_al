import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RIGHTS_STATEMENTS } from "@/lib/rights-statements";

// F4: the Edit page rendered, with and without migration 20261018091237
// (D1-D3), and with each rights state (P3/P4). The database reads are a
// small table-keyed double; the feature probe and the rights read are
// mocked so each case says exactly what the page was told.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("../../../actions", () => ({
  updateBook: { bind: () => async () => undefined },
  addContributor: { bind: () => async () => undefined },
  removeContributor: { bind: () => async () => undefined },
  publishBook: { bind: () => async () => undefined },
  unpublishBook: { bind: () => async () => undefined },
  deleteBook: { bind: () => async () => undefined },
}));

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";

let book: Record<string, unknown>;
const tableData: Record<string, unknown> = {};

function chain(table: string) {
  const resolve = () => Promise.resolve({ data: table === "books" ? book : tableData[table] ?? null, error: null });
  const proxy: object = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => resolve().then(f, r);
        return () => proxy;
      },
    },
  );
  return proxy;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
    from: (table: string) => chain(table),
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn/${p}` } }) }) },
  }),
}));

let features = { penName: true, rights: true };
vi.mock("@/lib/catalog-schema-features", () => ({ getCatalogSchemaFeatures: async () => features }));
type RightsState =
  | { kind: "present"; declaration: { basis: "own_rights" | "public_domain" } }
  | { kind: "none" }
  | { kind: "unavailable" };
let rightsState: RightsState = { kind: "none" };
vi.mock("@/lib/book-rights", () => ({ getRightsDeclarationState: async () => rightsState }));

const { default: EditBookPage } = await import("./page");

async function render(searchParams: Record<string, string> = {}): Promise<string> {
  const element = await EditBookPage({
    params: Promise.resolve({ id: BOOK_ID }),
    searchParams: Promise.resolve(searchParams),
  });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

function radio(html: string, basis: string): string {
  const match = html.match(new RegExp(`<input[^>]*name="rightsBasis"[^>]*value="${basis}"[^>]*>`));
  expect(match).not.toBeNull();
  return match![0];
}

function publishButton(html: string): string {
  const start = html.lastIndexOf("<button", html.indexOf("Publish book</button>"));
  return html.slice(start, html.indexOf("Publish book</button>"));
}

beforeEach(() => {
  book = {
    id: BOOK_ID,
    author_id: USER_ID,
    title: "Libri im",
    subtitle: null,
    description: "A real description.",
    keywords: "",
    isbn: null,
    language: "sq",
    genre: "Fiction",
    publisher: null,
    edition: null,
    original_publication_date: null,
    series_id: null,
    series_position: null,
    price_all: 0,
    price_cents: 0,
    status: "draft",
    cover_path: null,
    file_path: null,
    pen_name: null,
  };
  tableData.series = [];
  tableData.book_contributors = [];
  tableData.profiles = { display_name: "Renato Kalemi", public_author_name: "Arben Leka" };
  features = { penName: true, rights: true };
  rightsState = { kind: "none" };
});

describe("Edit page: Pen name (P1)", () => {
  it("is rendered with the book's pen name and the help naming the author", async () => {
    book.pen_name = "Jo Pen";
    const html = await render();
    expect(html).toContain("Pen name (optional)");
    const input = html.match(/<input[^>]*name="penName"[^>]*>/)![0];
    expect(input).toContain('maxLength="120"');
    expect(input).toContain('value="Jo Pen"');
    expect(html).toContain("Leave blank to use your author name, Arben Leka.");
    // Directly under Title.
    expect(html.indexOf('name="penName"')).toBeGreaterThan(html.indexOf('name="title"'));
    expect(html.indexOf('name="penName"')).toBeLessThan(html.indexOf('name="subtitle"'));
  });

  it("is kept by the draft keeper after an error (EDIT_BOOK_DRAFT_FIELDS)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const fields = source.slice(source.indexOf("const EDIT_BOOK_DRAFT_FIELDS"), source.indexOf("] as const;"));
    expect(fields).toContain('"penName"');
    expect(fields).not.toContain('"rightsBasis"');
  });
});

describe("Edit page: Rights (P3)", () => {
  it("a visible Rights legend and the two sentences from the constant, code point for code point", async () => {
    const html = await render();
    expect(html).toContain('<legend class="mb-3 font-bold text-foreground">Rights</legend>');
    for (const basis of ["own_rights", "public_domain"] as const) {
      const expected = RIGHTS_STATEMENTS[basis].text.replace(/'/g, "&#x27;");
      const label = html.match(new RegExp(`value="${basis}"[^>]*/><span[^>]*>([^<]*)</span>`));
      expect(label).not.toBeNull();
      expect([...label![1]].map((c) => c.codePointAt(0))).toEqual([...expected].map((c) => c.codePointAt(0)));
    }
    expect(html).not.toContain("&apos;");
  });

  it("the two sentences are plain text under the bold legend (Renato 10-18: 1. b)", async () => {
    const html = await render();
    for (const basis of ["own_rights", "public_domain"] as const) {
      expect(html).toMatch(new RegExp(`value="${basis}"[^>]*/><span class="text-foreground">`));
    }
  });

  it("no declaration -> nothing preselected", async () => {
    const html = await render();
    expect(radio(html, "own_rights")).not.toContain("checked");
    expect(radio(html, "public_domain")).not.toContain("checked");
  });

  it.each(["own_rights", "public_domain"] as const)("the stored basis (%s) is preselected", async (basis) => {
    rightsState = { kind: "present", declaration: { basis } };
    const html = await render();
    expect(radio(html, basis)).toContain('checked=""');
    expect(radio(html, basis === "own_rights" ? "public_domain" : "own_rights")).not.toContain("checked");
  });

  it("after an error redirect the stored basis shows again (the page re-reads it)", async () => {
    rightsState = { kind: "present", declaration: { basis: "public_domain" } };
    const html = await render({ error: "Something went wrong saving your changes. Please try again" });
    expect(radio(html, "public_domain")).toContain('checked=""');
  });

  it("is the last block of Book details, after Additional book details", async () => {
    const html = await render();
    const files = html.indexOf(">Files</h2>");
    expect(html.indexOf("Additional book details")).toBeLessThan(html.indexOf('name="rightsBasis"'));
    expect(html.indexOf('name="rightsBasis"')).toBeLessThan(files);
  });
});

describe("Edit page: the Publishing box (P4, D3)", () => {
  it("no declaration -> 'Choose the rights before publishing.' and Publish disabled", async () => {
    const html = await render();
    expect(html).toContain("Choose the rights before publishing.");
    expect(publishButton(html)).toContain('disabled=""');
  });

  it("the description notice comes first when both are missing", async () => {
    book.description = "";
    const html = await render();
    expect(html).toContain("Add a description before publishing.");
    expect(html).not.toContain("Choose the rights before publishing.");
  });

  it("with a declaration -> Ready to publish, Publish enabled", async () => {
    rightsState = { kind: "present", declaration: { basis: "own_rights" } };
    const html = await render();
    expect(html).toContain("Ready to publish.");
    expect(html).not.toContain("Choose the rights before publishing.");
    expect(publishButton(html)).not.toContain('disabled=""');
  });
});

describe("Edit page before the migration (D2/D3)", () => {
  beforeEach(() => {
    features = { penName: false, rights: false };
    rightsState = { kind: "unavailable" };
    delete book.pen_name;
  });

  it("no Pen name field and no Rights choice", async () => {
    const html = await render();
    expect(html).not.toContain('name="penName"');
    expect(html).not.toContain("Pen name (optional)");
    expect(html).not.toContain('name="rightsBasis"');
    expect(html).not.toContain(">Rights</legend>");
  });

  it("the Publishing box shows the existing generic sentence and Publish is disabled", async () => {
    const html = await render();
    expect(html).toContain("We couldn&#x27;t publish your book yet. Please try again from your dashboard");
    expect(html).not.toContain("Choose the rights before publishing.");
    expect(publishButton(html)).toContain('disabled=""');
  });

  it("a rights table that exists but cannot be read also hides the choice and shows the generic sentence", async () => {
    features = { penName: true, rights: true };
    const html = await render();
    expect(html).not.toContain('name="rightsBasis"');
    expect(html).toContain("We couldn&#x27;t publish your book yet. Please try again from your dashboard");
  });
});

describe("Edit page: iPhone step price box (I2)", () => {
  function priceBox(html: string): string {
    const start = html.indexOf("Price (ALL)");
    return html.slice(start, html.indexOf("</label>", start));
  }

  it("keeps name, type, inputMode, required and the stored price as defaultValue", async () => {
    book.price_all = 249;
    const html = await render();
    const input = html.match(/<input[^>]*name="price"[^>]*>/)![0];
    expect(input).toContain('type="text"');
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('required=""');
    expect(input).toContain('value="249"');
    expect(input).toContain("text-lg");
  });

  it("a legacy book with no ALL price still renders blank", async () => {
    book.price_all = null;
    const html = await render();
    expect(html.match(/<input[^>]*name="price"[^>]*>/)![0]).toContain('value=""');
  });

  it("is Add a book step 3's bordered box with the aria-hidden ALL tag, always the control border", async () => {
    const box = priceBox(await render());
    expect(box).toContain("max-w-[17.5rem]");
    expect(box).toContain("border-[#8c8472]");
    expect(box).toContain("focus-within:shadow-[var(--focus-ring)]");
    expect(box).not.toContain("border-red-700");
    expect(box).toMatch(/<span aria-hidden="true"[^>]*>ALL<\/span>/);
  });

  it("keeps the help sentence word for word, with 0 = free", async () => {
    const box = priceBox(await render());
    expect(box.replace(/<!-- -->/g, "")).toContain(
      "Whole lek: 0 for a free ebook, or 99 to 100000. Librum takes a 20% platform fee — you keep the rest of every sale.",
    );
  });
});

describe("Edit page: iPhone step manuscript line (I3)", () => {
  const STORAGE_NAME = "26525d0c-1111-4111-8111-111111111111.epub";

  it("names a stored EPUB as 'EPUB file', never by its storage name", async () => {
    book.file_path = `${USER_ID}/${STORAGE_NAME}`;
    const html = await render();
    expect(html).toContain("Current manuscript: EPUB file");
    expect(html).not.toContain(STORAGE_NAME);
    expect(html).not.toContain("26525d0c");
    expect(html.replace(/<!-- -->/g, "")).toContain("EPUB · up to 50 MB.</span>");
    // LEFTOVERS (L6, his Q1 = a): the paragraph says it once; the file
    // button no longer repeats it.
    expect(html.split("Leave blank to keep your current manuscript.")).toHaveLength(2);
  });

  // LEFTOVERS (L5a): nothing about the stored file reaches ManuscriptField
  // (a client component), so its name can never be sent to the browser.
  it("passes ManuscriptField no prop derived from the stored file", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    const start = source.indexOf("<ManuscriptField");
    expect(start).toBeGreaterThan(-1);
    expect(source.indexOf("<ManuscriptField", start + 1)).toBe(-1);
    const element = source.slice(start, source.indexOf("/>", start) + 2);
    expect(element).not.toMatch(/existingFilename|file_path|manuscriptLabel|getManuscriptLabel/);
    expect([...element.matchAll(/(\w+)=\{/g)].map((m) => m[1])).toEqual(["bookTitle", "authorName", "authorId"]);
  });

  it("no manuscript keeps 'No manuscript on file'", async () => {
    book.file_path = null;
    const html = await render();
    expect(html).toContain("No manuscript on file");
    expect(html).not.toContain("Current manuscript:");
    expect(html.replace(/<!-- -->/g, "")).toContain("EPUB · up to 50 MB.</span>");
  });
});
