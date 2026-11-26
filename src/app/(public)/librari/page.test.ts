import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GENRES } from "@/lib/genres";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate on this
// schema-sensitive public discovery page (V3 §3) -- not a general audit
// of Bookstore's own search/filter/sort logic, which has no page-level
// test file today.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn((): unknown => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("ADMIN_CLIENT_CALLED"); } }));

const { default: BookstorePage } = await import("./page");

function noParams() {
  return { searchParams: Promise.resolve({}) };
}

describe("BookstorePage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await BookstorePage(noParams());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Mirëmbajtje e planifikuar");
    expect(html).toContain("përkohësisht i padisponueshëm për mirëmbajtje të planifikuar");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no price, book title, or other configuration/identifier value", async () => {
    const element = await BookstorePage(noParams());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toMatch(/ALL_CUTOVER_MAINTENANCE_MODE/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(BookstorePage(noParams())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// ============================================================
// LR1 (Renato 11-25, Libraria patch 1): the shelves view and the results
// view, rendered against a small in-memory double that evaluates the
// filters the page asks for.
// ============================================================
type Row = Record<string, unknown>;

// Makes every public_books LIST read fail.
let failBookList = false;

function tableStub(rows: Row[]) {
  let result = [...rows];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: unknown) => ((result = result.filter((r) => r[col] === value)), builder),
    is: (col: string, value: unknown) => ((result = result.filter((r) => (r[col] ?? null) === value)), builder),
    not: (col: string) => ((result = result.filter((r) => r[col] != null)), builder),
    contains: (col: string, values: unknown[]) =>
      ((result = result.filter((r) => values.every((v) => ((r[col] as unknown[]) ?? []).includes(v)))), builder),
    in: (col: string, values: unknown[]) => ((result = result.filter((r) => values.includes(r[col]))), builder),
    overlaps: (col: string, values: unknown[]) =>
      ((result = result.filter((r) => ((r[col] as unknown[]) ?? []).some((v) => values.includes(v)))), builder),
    order: (col: string, opts?: { ascending?: boolean }) =>
      ((result = [...result].sort((a, b) =>
        opts?.ascending ? String(a[col]).localeCompare(String(b[col])) : String(b[col]).localeCompare(String(a[col])),
      )),
      builder),
    limit: (n: number) => ((result = result.slice(0, n)), builder),
    returns: () => builder,
    maybeSingle: () => Promise.resolve({ data: result[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null }),
  };
  return builder;
}

function failing() {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "contains", "in", "overlaps", "order", "limit", "returns"]) builder[m] = () => builder;
  builder.maybeSingle = () => Promise.resolve({ data: null, error: null });
  builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "boom" } });
  return builder;
}

function book(n: number, priceAll: number, categories: string[] = ["Letërsi artistike"], extra: Row = {}): Row {
  const day = String(n).padStart(2, "0");
  return {
    id: `book-${day}`, title: `Book ${day}`, status: "published", price_all: priceAll,
    genre: categories[0], categories, cover_path: null, description: `About ${day}.`,
    created_at: `2026-10-${day}T00:00:00Z`, pen_name_id: "pen-an-author", original_author: null, is_adult: false,
    pen: { id: "pen-an-author", name: "An Author" }, ...extra,
  };
}

// Ten books, newest = book-10. Book 9 is free, book 8 a pre-order;
// books 2 and 4 are non-fiction (Histori, Filozofi).
const BOOKS: Row[] = Array.from({ length: 10 }, (_, i) => {
  const n = i + 1;
  if (n === 9) return book(n, 0);
  if (n === 8) return book(n, 299, ["Letërsi artistike"], { status: "preorder", release_date: "2026-12-18" });
  if (n === 2) return book(n, 199, ["Histori"]);
  if (n === 4) return book(n, 249, ["Filozofi", "Letërsi artistike"]);
  return book(n, 199);
});

let bookRows: Row[] = BOOKS;
let signedInUser: { id: string } | null = null;
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let bundleRows: Row[] = [];
let reviewRows: Row[] = [];
let cartRows: Row[] = [];
let purchaseRows: Row[] = [];
let authorBookRows: Row[] = [];
let ownedIds: string[] = [];
let categoryRows: Row[] = [];
let failCategoryRead = false;
let slideRows: Row[] = [];
let failSlideRead = false;
let pickRows: Row[] = [];
let failPickRead = false;

function pickRow(n: number, bookId: string, extra: Row = {}): Row {
  return {
    id: `pick-${n}`, book_id: bookId, badge: "Zgjedhja e Librum", note: `Pick note ${n}.`, quote: `Pick quote ${n}.`,
    quote_from: "book", published_at: `2026-11-${String(10 + n).padStart(2, "0")}T09:00:00Z`, ...extra,
  };
}

const PIC = (n: number) => `slides/0000000${n}-0000-4000-8000-000000000000.jpg`;
function slideRow(n: number, bookId: string, extra: Row = {}): Row {
  return { id: `slide-${n}`, position: n, book_id: bookId, description: `Slide line ${n}.`, tag: null, image_path: PIC(n), phone_image_path: null, ...extra };
}

describe("BookstorePage: LR1 shop front", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    signedInUser = null;
    bookRows = BOOKS;
    failBookList = false;
    bundleRows = [];
    reviewRows = [];
    cartRows = [];
    purchaseRows = [];
    authorBookRows = [];
    ownedIds = [];
    categoryRows = [];
    failCategoryRead = false;
    slideRows = [];
    failSlideRead = false;
    pickRows = [];
    failPickRead = false;
    rpcCalls = [];
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => ({
      auth: { getUser: () => Promise.resolve({ data: { user: signedInUser } }) },
      from: (table: string) => {
        if (table === "public_books" && failBookList) return failing();
        if (table === "libraria_category_buttons") return failCategoryRead ? failing() : tableStub(categoryRows);
        if (table === "public_libraria_banner_slides") return failSlideRead ? failing() : tableStub(slideRows);
        if (table === "public_libraria_reading_picks") return failPickRead ? failing() : tableStub(pickRows);
        return tableStub(
          table === "public_books"
            ? bookRows
            : table === "public_bundles"
              ? bundleRows
              : table === "public_reviews"
                ? reviewRows
                : table === "cart_items"
                  ? cartRows
                  : table === "purchases"
                    ? purchaseRows
                    : table === "books"
                      ? authorBookRows
                      : [],
        );
      },
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        if (name === "user_owns_book") return Promise.resolve({ data: ownedIds.includes(String(args.target_book_id)), error: null });
        const term = String(args.search_term ?? "").toLowerCase();
        return Promise.resolve({
          data: bookRows
            .filter((r) => r.price_all != null)
            .filter((r) => String(r.title).toLowerCase().includes(term))
            .map((r) => ({ book_id: r.id })),
          error: null,
        });
      },
      storage: {
        from: (bucket: string) => ({
          getPublicUrl: (path: string) => ({
            data: { publicUrl: bucket === "libraria" ? `https://cdn.example/libraria/${path}` : "https://cdn.example/c.png" },
          }),
        }),
      },
    }));
  });

  async function render(params: Record<string, string> = {}) {
    const element = await BookstorePage({ searchParams: Promise.resolve(params) });
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]).replace(/<script>[\s\S]*?<\/script>/g, "");
  }

  function section(html: string, heading: string): string {
    const start = html.indexOf(`>${heading}</h2>`);
    expect(start, heading).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  const titles = (html: string) => [...html.matchAll(/group-hover:underline">(Book \d\d)</g)].map((m) => m[1]);
  // An <a> with this href (any attribute order) whose text starts with `text`.
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linkRe = (href: string, text: string, extra = "") =>
    new RegExp(`<a\\b(?=[^>]*href="${esc(href)}")${extra ? `(?=[^>]*${extra})` : ""}[^>]*>${esc(text)}<`);

  it("the shelves view: hidden Libraria heading, no strip, the newest five, and none of the old page", async () => {
    const html = await render();
    expect(html).toContain('<h1 class="sr-only">Libraria</h1>');
    // lr3-6 a: the old "Zgjedhja e Librum" / "I ri në Librum" strip is gone.
    for (const gone of ["I ri në Librum", "Zgjedhja e Librum"]) expect(html, gone).not.toContain(gone);
    expect(titles(section(html, "Më të rinjtë në Librum"))).toEqual(["Book 10", "Book 09", "Book 08", "Book 07", "Book 06"]);
    for (const gone of ["Filtrat", "Renditja", "Zhanri", "Klasikët shqiptarë", "Jeni autor?", "Filloni të publikoni", "Të gjithë librat", "Hiq të gjitha"]) {
      expect(html, gone).not.toContain(gone);
    }
    expect(html).not.toContain("›</a>");
  });

  it("category buttons: Të gjitha kategoritë selected, the first four categories with books in A–Zh order, then the box", async () => {
    bookRows = [
      ...BOOKS,
      book(11, 199, ["Romancë"]),
      book(12, 199, ["Biografi & kujtime"]),
      book(13, 199, ["Horror"]),
    ];
    const html = await render();
    const shelf = section(html, "Më të rinjtë në Librum");
    expect(shelf).toMatch(linkRe("/librari", "Të gjitha kategoritë", 'aria-current="page"'));
    const buttons = [...shelf.slice(0, shelf.indexOf("<details")).matchAll(/href="\/librari\?genre=([^"]*)"/g)].map((m) =>
      decodeURIComponent(m[1].replace(/\+/g, " ")).replace(/&amp;/g, "&"),
    );
    expect(buttons).toEqual(["Biografi & kujtime", "Filozofi", "Histori", "Horror"]);
    expect(shelf).toContain("Më shumë kategori");
  });

  // LR1 patch 2 (lb5 a, lr2-3 a, lr2-4 b, lr2-5 b).
  const buttonsOf = (html: string) => {
    const shelf = section(html, "Më të rinjtë në Librum");
    return [...shelf.slice(0, shelf.indexOf("<details")).matchAll(/href="\/librari\?genre=([^"]*)"/g)].map((m) =>
      decodeURIComponent(m[1].replace(/\+/g, " ")).replace(/&amp;/g, "&"),
    );
  };

  it("category buttons: staff's list in their order, up to 6, each shown even with no books", async () => {
    categoryRows = [
      { position: 3, category: "Poezi" },
      { position: 1, category: "Romancë" },
      { position: 2, category: "Histori" },
    ];
    expect(buttonsOf(await render())).toEqual(["Romancë", "Histori", "Poezi"]);
  });

  it("category buttons: none saved, or the read fails, falls back to the first four with books, A–Zh", async () => {
    expect(buttonsOf(await render())).toEqual(["Filozofi", "Histori", "Letërsi artistike"]);
    failCategoryRead = true;
    categoryRows = [{ position: 1, category: "Romancë" }];
    expect(buttonsOf(await render())).toEqual(["Filozofi", "Histori", "Letërsi artistike"]);
  });

  it("Libra që i gjeni vetëm në Librum: the newest five ticked books after Më të rinjtë, hidden without any", async () => {
    expect(await render()).not.toContain("Libra që i gjeni vetëm në Librum");
    bookRows = BOOKS.map((b) =>
      ["book-01", "book-03", "book-05", "book-06", "book-07", "book-09"].includes(String(b.id)) ? { ...b, only_on_librum: true } : b,
    );
    const html = await render();
    expect(titles(section(html, "Libra që i gjeni vetëm në Librum"))).toEqual(["Book 09", "Book 07", "Book 06", "Book 05", "Book 03"]);
    expect(html.indexOf("Më të rinjtë në Librum")).toBeLessThan(html.indexOf("Libra që i gjeni vetëm në Librum"));
    expect(html.indexOf("Libra që i gjeni vetëm në Librum")).toBeLessThan(html.indexOf("Libra jo-artistikë"));
  });

  it("the Më shumë kategori box lists every category as a plain link to its results, with a close button", async () => {
    const html = await render();
    const box = html.slice(html.indexOf('aria-label="Të gjitha kategoritë"'), html.indexOf("</details>"));
    for (const g of GENRES) {
      const href = `/librari?genre=${new URLSearchParams({ g }).toString().slice(2)}`.replace(/&/g, "&amp;");
      expect(box, g).toContain(`href="${href}"`);
    }
    expect(box).toContain('aria-label="Mbyll kategoritë"');
    expect(box).not.toContain("rounded-full border");
  });

  it("Libra jo-artistikë holds only non-fiction books, and hides without any", async () => {
    const html = await render();
    expect(titles(section(html, "Libra jo-artistikë"))).toEqual(["Book 04", "Book 02"]);
    bookRows = BOOKS.filter((b) => b.id !== "book-02" && b.id !== "book-04");
    expect(await render()).not.toContain("Libra jo-artistikë");
  });

  it("a visitor sees Bota e leximit ju pret with the reader sign-up; a signed-in reader does not", async () => {
    const html = await render();
    const invite = section(html, "Bota e leximit ju pret");
    expect(invite).toContain(
      "Krijoni një llogari falas në Librum dhe regjistrohuni për të marrë emailet tona. Mësoni më shumë për librat e\n        rinj, ofertat dhe merrni sugjerime leximi nga ekipi ynë.".replace(/\n\s+/g, " "),
    );
    expect(invite).toMatch(linkRe("/signup", "Krijo llogari"));
    signedInUser = { id: "reader-1" };
    expect(await render()).not.toContain("Bota e leximit ju pret");
  });

  it("card buttons for a visitor: Shto through log in, Merre falas and Shiko librin to the book page", async () => {
    const html = await render();
    const shelf = section(html, "Më të rinjtë në Librum");
    expect(shelf).toMatch(linkRe("/login?next=/librari", "Shto"));
    expect(shelf).toMatch(linkRe("/libra/book-09", "Merre falas"));
    expect(shelf).toMatch(linkRe("/libra/book-08", "Shiko librin"));
    expect(shelf).not.toContain("<form");
  });

  it("card buttons for a signed-in reader: a Shto form, and Në shportë for a book already in the cart (gift rows don't count)", async () => {
    signedInUser = { id: "reader-1" };
    cartRows = [
      { reader_id: "reader-1", book_id: "book-10", gift_email: null },
      { reader_id: "reader-1", book_id: "book-07", gift_email: "friend@example.test" },
    ];
    const shelf = section(await render(), "Më të rinjtë në Librum");
    const card10 = shelf.slice(shelf.indexOf(">Book 10<"), shelf.indexOf(">Book 09<"));
    expect(card10).toMatch(linkRe("/shporta", "Në shportë"));
    const card07 = shelf.slice(shelf.indexOf(">Book 07<"), shelf.indexOf(">Book 06<"));
    expect(card07).toMatch(/<form[\s\S]*<button type="submit"[^>]*>Shto<\/button>/);
  });

  it("lr1-12 a: a book the reader owns and the author's own book show Shiko librin; a refunded purchase shows Shto again", async () => {
    signedInUser = { id: "reader-1" };
    purchaseRows = [
      { reader_id: "reader-1", book_id: "book-10" },
      { reader_id: "reader-1", book_id: "book-06" },
      { reader_id: "reader-1", book_id: "book-09" },
    ];
    ownedIds = ["book-10", "book-09"]; // book-06 was refunded
    authorBookRows = [{ id: "book-07", author_id: "reader-1" }];
    const shelf = section(await render(), "Më të rinjtë në Librum");
    const card = (a: string, b: string) => shelf.slice(shelf.indexOf(`>${a}<`), shelf.indexOf(`>${b}<`));
    expect(card("Book 10", "Book 09")).toMatch(linkRe("/libra/book-10", "Shiko librin"));
    expect(card("Book 10", "Book 09")).not.toContain(">Shto<");
    expect(card("Book 09", "Book 08")).toMatch(linkRe("/libra/book-09", "Shiko librin"));
    expect(card("Book 09", "Book 08")).not.toContain("Merre falas");
    expect(card("Book 07", "Book 06")).toMatch(linkRe("/libra/book-07", "Shiko librin"));
    expect(card("Book 06", "Libra jo-artistikë")).toMatch(/<button type="submit"[^>]*>Shto<\/button>/);
    expect(rpcCalls.filter((c) => c.name === "user_owns_book").map((c) => c.args.target_book_id).sort()).toEqual(["book-06", "book-09", "book-10"]);
  });

  it("a visitor triggers no ownership reads", async () => {
    await render();
    expect(rpcCalls.filter((c) => c.name === "user_owns_book")).toEqual([]);
  });

  it("stars: an average and count for a reviewed book, nothing for one without reviews", async () => {
    reviewRows = [
      { book_id: "book-10", rating: 5 },
      { book_id: "book-10", rating: 4 },
    ];
    const shelf = section(await render(), "Më të rinjtë në Librum");
    const card10 = shelf.slice(shelf.indexOf(">Book 10<"), shelf.indexOf(">Book 09<"));
    expect(card10).toContain("4,5 nga 5 yje, 2 vlerësime");
    expect(card10).toContain("(2)");
    const card09 = shelf.slice(shelf.indexOf(">Book 09<"), shelf.indexOf(">Book 08<"));
    expect(card09).not.toContain("★");
  });

  it("a category opens the results: its name as the title, the count, a chip back, only its books, no shelves", async () => {
    const html = await render({ genre: "Filozofi" });
    expect(html).toMatch(/<h1[^>]*>Filozofi<\/h1>/);
    expect(html).toContain(">1 libër<");
    expect(html).toMatch(new RegExp('<a\\b(?=[^>]*aria-label="Hiq Filozofi")(?=[^>]*href="/librari")'));
    expect(titles(html)).toEqual(["Book 04"]);
    expect(html).not.toContain("Më të rinjtë në Librum");
    expect(html).not.toContain("I ri në Librum");
    expect(html).not.toContain("Bota e leximit ju pret");
  });

  it("a search opens the results through search_books with no genre and no price", async () => {
    const html = await render({ q: "Book 0" });
    expect(rpcCalls).toEqual([
      { name: "search_books", args: { search_term: "Book 0", genre_filter: null, min_price_cents: null, max_price_cents: null, result_limit: 500 } },
    ]);
    expect(html).toMatch(/<h1[^>]*>“Book 0”<\/h1>/);
    expect(titles(html)).toEqual(["Book 09", "Book 08", "Book 07", "Book 06", "Book 05", "Book 04", "Book 03", "Book 02", "Book 01"]);
  });

  it("old links with sort or a price still open the shelves view; the parts are ignored", async () => {
    const html = await render({ sort: "price_asc", minPrice: "500", maxPrice: "0" });
    expect(html).toContain("Më të rinjtë në Librum");
    expect(titles(section(html, "Më të rinjtë në Librum"))).toHaveLength(5);
  });

  it("no match shows the help line and a way back; an unknown genre is ignored", async () => {
    const html = await render({ q: "zzz" });
    expect(html).toContain("Asnjë libër nuk përputhet me kërkimin tuaj.");
    expect(html).toMatch(linkRe("/librari", "Kthehu te Libraria"));
    expect(await render({ genre: "Nope" })).toContain("Më të rinjtë në Librum");
  });

  it("no slides showing, or the slides read fails: no banner", async () => {
    expect(await render()).not.toContain('aria-roledescription="carousel"');
    slideRows = [slideRow(1, "book-03")];
    failSlideRead = true;
    expect(await render()).not.toContain('aria-roledescription="carousel"');
  });

  it("the banner: the view's slides in order, each with the book's own title, author, cover and link (lr3-1 a)", async () => {
    slideRows = [
      slideRow(1, "book-03", { tag: "Ofertë e javës", phone_image_path: PIC(7) }),
      slideRow(2, "book-08"),
      slideRow(3, "book-missing"),
    ];
    const html = await render();
    expect(html).toContain('aria-roledescription="carousel"');
    // A slide whose book the shop can't read hides by itself (lr3-5 a).
    expect(html).not.toContain("Slide line 3.");
    expect(html).toContain('aria-label="1 nga 2"');
    expect(html.indexOf("Slide line 1.")).toBeLessThan(html.indexOf("Slide line 2."));
    expect(html).toMatch(linkRe("/libra/book-03", "", 'class="[^"]*group relative'));
    expect(html).toContain(">Book 03</p>");
    expect(html).toContain("nga An Author");
    expect(html).toContain(">Ofertë e javës</span>");
    expect(html).toContain(`srcSet="https://cdn.example/libraria/${PIC(7)}"`);
    expect(html).toContain(`src="https://cdn.example/libraria/${PIC(1)}"`);
    expect(html).toContain("Shiko librin");
    // Two slides: arrows and dots.
    expect(html).toContain('aria-label="Slajdi tjetër"');
    expect(html).toContain('aria-label="Shko te slajdi 2"');
  });

  // LR1 patch 4: "Çfarë po lexojmë".
  it("no pick, or the picks read fails: no Çfarë po lexojmë section", async () => {
    expect(await render()).not.toContain("Çfarë po lexojmë");
    pickRows = [pickRow(1, "book-03")];
    failPickRead = true;
    expect(await render()).not.toContain("Çfarë po lexojmë");
  });

  it("the newest pick shows after Libra që i gjeni vetëm në Librum and before Libra jo-artistikë (lr4-1 a)", async () => {
    bookRows = BOOKS.map((b) => (b.id === "book-05" ? { ...b, only_on_librum: true } : b));
    pickRows = [pickRow(1, "book-03"), pickRow(3, "book-06", { badge: null, quote_from: "author" })];
    reviewRows = [{ book_id: "book-06", rating: 4 }, { book_id: "book-06", rating: 5 }];
    const html = await render();
    const pick = section(html, "Çfarë po lexojmë");
    expect(html.indexOf("Libra që i gjeni vetëm në Librum")).toBeLessThan(html.indexOf("Çfarë po lexojmë"));
    expect(html.indexOf("Çfarë po lexojmë")).toBeLessThan(html.indexOf("Libra jo-artistikë"));
    // pick-3 is the newest; pick-1 is a past pick.
    expect(pick).toContain("Pick note 3.");
    expect(pick).not.toContain("Pick note 1.");
    expect(pick).toContain("Pick quote 3.");
    expect(pick).toContain("autori i librit");
    expect(pick).not.toContain("Zgjedhja e Librum");
    expect(pick).toMatch(linkRe("/libra/book-06", "Book 06"));
    expect(pick).toContain("(Autor)");
    expect(pick).toContain("4,5 nga 5 yje, 2 vlerësime");
    expect(pick).toContain("199 lekë");
    expect(pick).toMatch(linkRe("/login?next=/librari", "Shto"));
    expect(pick).toMatch(linkRe("/librari/cfare-po-lexojme", "Më shumë ›"));
  });

  it("a pick quoted from the book: badge, nga <title>; with only one pick there is no Më shumë", async () => {
    pickRows = [pickRow(1, "book-03")];
    const pick = section(await render(), "Çfarë po lexojmë");
    expect(pick).toContain(">Zgjedhja e Librum</span>");
    expect(pick).toContain("nga <i>Book 03</i>");
    expect(pick).not.toContain("Më shumë");
  });

  it("an 18+ pick shows no 18+ tag (lr4-5 b); a free pick says Merre falas, a pre-order Shiko librin", async () => {
    bookRows = BOOKS.map((b) => (b.id === "book-03" ? { ...b, is_adult: true } : b));
    pickRows = [pickRow(1, "book-03")];
    expect(section(await render(), "Çfarë po lexojmë")).not.toContain("18+");
    pickRows = [pickRow(1, "book-09")];
    expect(section(await render(), "Çfarë po lexojmë")).toMatch(linkRe("/libra/book-09", "Merre falas"));
    pickRows = [pickRow(1, "book-08")];
    expect(section(await render(), "Çfarë po lexojmë")).toMatch(linkRe("/libra/book-08", "Shiko librin"));
  });

  it("a pick whose book the shop can't read is skipped; the next one shows (lr4-3 a)", async () => {
    pickRows = [pickRow(2, "book-missing"), pickRow(1, "book-03")];
    const pick = section(await render(), "Çfarë po lexojmë");
    expect(pick).toContain("Pick note 1.");
    expect(pick).not.toContain("Pick note 2.");
  });

  it("a signed-in reader: Shto is a form, Në shportë once in the cart, Shiko librin for an owned book", async () => {
    signedInUser = { id: "reader-1" };
    pickRows = [pickRow(1, "book-03")];
    expect(section(await render(), "Çfarë po lexojmë")).toContain('aria-label="Shto në shportë: Book 03"');
    cartRows = [{ reader_id: "reader-1", book_id: "book-03", gift_email: null }];
    expect(section(await render(), "Çfarë po lexojmë")).toMatch(linkRe("/shporta", "Në shportë"));
    cartRows = [];
    purchaseRows = [{ reader_id: "reader-1", book_id: "book-03" }];
    ownedIds = ["book-03"];
    expect(section(await render(), "Çfarë po lexojmë")).toMatch(linkRe("/libra/book-03", "Shiko librin"));
  });

  it("one slide: no arrows and no dots", async () => {
    slideRows = [slideRow(1, "book-03")];
    const html = await render();
    expect(html).toContain("Slide line 1.");
    expect(html).not.toContain("Slajdi tjetër");
    expect(html).not.toContain("Shko te slajdi");
  });

  it("an empty shop says so; a failed load says it could not open, with no strip", async () => {
    bookRows = [];
    expect(await render()).toContain("Ende nuk ka libra.");
    bookRows = BOOKS;
    failBookList = true;
    const html = await render();
    expect(html).toContain("Libraria nuk u hap dot tani.");
    expect(html).not.toContain("I ri në Librum");
    expect(await render({ genre: "Filozofi" })).toContain("Libraria nuk u hap dot tani.");
  });

  it("phone width: the sideways shelf rows are positioned, so their hidden star text can't widen the page", async () => {
    const html = await render();
    const rows = html.match(/<ul class="[^"]*overflow-x-auto[^"]*"/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toMatch(/class="relative /);
  });
});
