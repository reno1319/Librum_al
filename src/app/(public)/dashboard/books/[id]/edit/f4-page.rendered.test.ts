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
  cancelBookReview: { bind: () => async () => undefined },
}));
// ADMIN-3-REVIEW: a draft with no approval and nothing pending -- the
// Publish control reads "Dërgojeni për shqyrtim" (its own states are in
// review-state.rendered.test.ts).
vi.mock("@/lib/book-reviews", () => ({
  getBookReviewState: async () => ({ kind: "ok", pending: false, approvalValid: false, latestSentBack: null }),
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
  const start = html.lastIndexOf("<button", html.indexOf("Dërgojeni për shqyrtim</button>"));
  return html.slice(start, html.indexOf("Dërgojeni për shqyrtim</button>"));
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
    genre: "Letërsi artistike",
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
    // PEN-NAMES-2 (D4): books.pen_name is gone; the page embeds the
    // book's pen name from public_pen_names as `pen`.
    pen: { id: "pen-default", name: "Arben Leka" },
  };
  tableData.pen_names = [
    { name: "Arben Leka", is_default: true },
    { name: "Jo Pen", is_default: false },
  ];
  tableData.series = [];
  tableData.book_contributors = [];
  tableData.profiles = { display_name: "Renato Kalemi", public_author_name: "Arben Leka" };
  features = { penName: true, rights: true };
  rightsState = { kind: "none" };
});

describe("Edit page: Pen name (P1)", () => {
  it("is rendered with the book's pen name and the help naming the author", async () => {
    book.pen = { id: "pen-jo", name: "Jo Pen" };
    const html = await render();
    expect(html).toContain("Pseudonimi (opsional)");
    const input = html.match(/<input[^>]*name="penName"[^>]*>/)![0];
    expect(input).toContain('maxLength="120"');
    expect(input).toContain('value="Jo Pen"');
    expect(html).toContain("Lëreni bosh për të përdorur emrin tuaj si autor, Arben Leka.");
    // Directly under Title.
    expect(html.indexOf('name="penName"')).toBeGreaterThan(html.indexOf('name="title"'));
    expect(html.indexOf('name="penName"')).toBeLessThan(html.indexOf('name="subtitle"'));
  });

  it("is blank when the book is under the default pen name (blank means your author name)", async () => {
    const html = await render();
    const input = html.match(/<input[^>]*name="penName"[^>]*>/)![0];
    expect(input).toContain('value=""');
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
    expect(html).toContain('<legend class="mb-3 font-bold text-foreground">Të drejtat</legend>');
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
    const html = await render({ error: "Diçka shkoi keq gjatë ruajtjes së ndryshimeve. Provoni përsëri" });
    expect(radio(html, "public_domain")).toContain('checked=""');
  });

  it("is the last block of Book details, after Të dhëna të tjera për librin", async () => {
    const html = await render();
    const files = html.indexOf(">Skedarët</h2>");
    expect(html.indexOf("Të dhëna të tjera për librin")).toBeLessThan(html.indexOf('name="rightsBasis"'));
    expect(html.indexOf('name="rightsBasis"')).toBeLessThan(files);
  });
});

describe("Edit page: the Publishing box (P4, D3)", () => {
  it("no declaration -> 'Zgjidhni të drejtat para publikimit.' and Publish disabled", async () => {
    const html = await render();
    expect(html).toContain("Zgjidhni të drejtat para publikimit.");
    expect(publishButton(html)).toContain('disabled=""');
  });

  it("the description notice comes first when both are missing", async () => {
    book.description = "";
    const html = await render();
    expect(html).toContain("Shtoni një përshkrim para publikimit.");
    expect(html).not.toContain("Zgjidhni të drejtat para publikimit.");
  });

  it("with a declaration -> Ready to send for review, the control enabled", async () => {
    rightsState = { kind: "present", declaration: { basis: "own_rights" } };
    const html = await render();
    // ADMIN-3-REVIEW (B): no approval yet, so the line names the review.
    expect(html).toContain("Gati për t&#x27;u dërguar për shqyrtim.");
    expect(html).not.toContain("Zgjidhni të drejtat para publikimit.");
    expect(publishButton(html)).not.toContain('disabled=""');
  });
});

describe("Edit page before the migration (D2/D3)", () => {
  beforeEach(() => {
    features = { penName: false, rights: false };
    rightsState = { kind: "unavailable" };
  });

  // PEN-NAMES-2: the Pen name field no longer depends on a schema probe
  // (pen names exist since PEN-NAMES-1); only the Rights choice does.
  it("the Pen name field is still shown, and there is no Rights choice", async () => {
    const html = await render();
    expect(html).toContain('name="penName"');
    expect(html).toContain("Pseudonimi (opsional)");
    expect(html).not.toContain('name="rightsBasis"');
    expect(html).not.toContain(">Të drejtat</legend>");
  });

  it("the Publishing box shows the existing generic sentence and Publish is disabled", async () => {
    const html = await render();
    expect(html).toContain("Libri juaj nuk u publikua dot ende. Provoni përsëri nga paneli juaj");
    expect(html).not.toContain("Zgjidhni të drejtat para publikimit.");
    expect(publishButton(html)).toContain('disabled=""');
  });

  it("a rights table that exists but cannot be read also hides the choice and shows the generic sentence", async () => {
    features = { penName: true, rights: true };
    const html = await render();
    expect(html).not.toContain('name="rightsBasis"');
    expect(html).toContain("Libri juaj nuk u publikua dot ende. Provoni përsëri nga paneli juaj");
  });
});

describe("Edit page: iPhone step price box (I2)", () => {
  function priceBox(html: string): string {
    const start = html.indexOf("Çmimi (lekë)");
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
    expect(box).toMatch(/<span aria-hidden="true"[^>]*>lekë<\/span>/);
  });

  it("keeps the help sentence word for word, with 0 = free", async () => {
    const box = priceBox(await render());
    expect(box.replace(/<!-- -->/g, "")).toContain(
      "Lekë të plota: 0 për e-libër falas, ose nga 99 deri në 100.000. Librum mban një tarifë platforme prej 20%; pjesa tjetër e çdo shitjeje është e juaja.",
    );
  });
});

describe("Edit page: iPhone step manuscript line (I3)", () => {
  const STORAGE_NAME = "26525d0c-1111-4111-8111-111111111111.epub";

  it("names a stored EPUB as 'EPUB file', never by its storage name", async () => {
    book.file_path = `${USER_ID}/${STORAGE_NAME}`;
    const html = await render();
    expect(html).toContain("Dorëshkrimi aktual: skedar EPUB");
    expect(html).not.toContain(STORAGE_NAME);
    expect(html).not.toContain("26525d0c");
    expect(html.replace(/<!-- -->/g, "")).toContain("EPUB · deri në 50 MB.</span>");
    // LEFTOVERS (L6, his Q1 = a): the paragraph says it once; the file
    // button no longer repeats it.
    expect(html.split("Lëreni bosh për të mbajtur dorëshkrimin aktual.")).toHaveLength(2);
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

  it("no manuscript keeps 'Nuk ka dorëshkrim'", async () => {
    book.file_path = null;
    const html = await render();
    expect(html).toContain("Nuk ka dorëshkrim");
    expect(html).not.toContain("Dorëshkrimi aktual:");
    expect(html.replace(/<!-- -->/g, "")).toContain("EPUB · deri në 50 MB.</span>");
  });
});
