import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// LR1 patch 2 (lb5 a): the admin Libraria page.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("./actions", () => ({ saveCategoryButtons: vi.fn() }));
vi.mock("./banner-actions", () => ({
  saveBannerSlide: vi.fn(),
  deleteBannerSlide: vi.fn(),
  moveBannerSlide: vi.fn(),
}));
vi.mock("./pick-actions", () => ({ saveReadingPick: vi.fn(), deleteReadingPick: vi.fn() }));

type Read = { data: unknown; error: { message: string } | null };
let read: Read;
let slidesRead: Read;
let booksRead: Read;
let picksRead: Read;
const reads: string[] = [];
const bookFilters: unknown[][] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      from: (table: string) => {
        reads.push(table);
        const result = () =>
          Promise.resolve(
            table === "libraria_category_buttons"
              ? read
              : table === "libraria_banner_slides"
                ? slidesRead
                : table === "libraria_reading_picks"
                  ? picksRead
                  : booksRead,
          );
        const chain = {
          select: () => chain,
          order: () => chain,
          in: (...args: unknown[]) => (bookFilters.push(["in", ...args]), chain),
          not: (...args: unknown[]) => (bookFilters.push(["not", ...args]), chain),
          limit: () => chain,
          returns: result,
        };
        return chain;
      },
      storage: {
        from: (bucket: string) => ({
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/${bucket}/${path}` } }),
        }),
      },
    }),
}));

const BOOK_A = "11111111-1111-4111-8111-111111111111";
const BOOK_B = "22222222-2222-4222-8222-222222222222";
const SLIDE_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLIDE_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PIC = "slides/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg";
function slide(id: string, position: number, bookId: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    position,
    book_id: bookId,
    description: `Description ${position}.`,
    tag: null,
    image_path: PIC,
    phone_image_path: null,
    starts_on: null,
    ends_on: null,
    ...extra,
  };
}

const { default: AdminLibrariaPage } = await import("./page");

async function render(search: Record<string, string> = {}) {
  const element = await AdminLibrariaPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element as ReactElement);
}

describe("AdminLibrariaPage", () => {
  beforeEach(() => {
    mockRequireStaff.mockReset();
    mockRequireStaff.mockResolvedValue({ userId: "staff-1", role: "owner" });
    reads.length = 0;
    bookFilters.length = 0;
    read = { data: [{ position: 1, category: "Romancë" }, { position: 2, category: "Poezi" }], error: null };
    slidesRead = { data: [], error: null };
    picksRead = { data: [], error: null };
    booksRead = {
      data: [
        { id: BOOK_A, title: "Libri A", status: "published", cover_path: null, original_author: null, pen: { id: "p1", name: "Autori A" } },
        { id: BOOK_B, title: "Libri B", status: "preorder", cover_path: null, original_author: null, pen: { id: "p2", name: "Autori B" } },
      ],
      error: null,
    };
  });

  it("gates on catalog.feature and reads nothing when denied", async () => {
    mockRequireStaff.mockRejectedValueOnce(new RedirectSignal("/admin"));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(reads).toEqual([]);
  });

  it("six ordered dropdowns, filled with staff's list, the rest None", async () => {
    const html = await render();
    expect(reads).toEqual(["libraria_category_buttons", "libraria_banner_slides", "public_books", "libraria_reading_picks"]);
    for (let i = 1; i <= 6; i++) expect(html).toContain(`name="slot${i}"`);
    expect(html).not.toContain('name="slot7"');
    expect(html.match(/<option value="Romancë" selected="">/g)).toHaveLength(1);
    expect(html.match(/<option value="Poezi" selected="">/g)).toHaveLength(1);
    expect(html.match(/<option value="" selected="">None<\/option>/g)).toHaveLength(4);
  });

  it("a failed category read shows no category form", async () => {
    read = { data: null, error: { message: "boom" } };
    const html = await render();
    expect(html).toContain("Couldn’t load the category buttons. Please reload the page.");
    expect(html).not.toContain('name="slot1"');
    expect(html).toContain('id="banner-form"');
  });

  it("a failed slides or books read shows no slide list or form", async () => {
    for (const fail of ["slides", "books"] as const) {
      slidesRead = fail === "slides" ? { data: null, error: { message: "boom" } } : { data: [], error: null };
      booksRead = fail === "books" ? { data: null, error: { message: "boom" } } : booksRead;
      const html = await render();
      expect(html).not.toContain('id="banner-form"');
      expect(html).toContain('name="slot1"');
    }
  });

  it("no slides: says there is no banner and offers the Add form with a required picture", async () => {
    const html = await render();
    expect(html).toContain("No slides yet: Libraria shows no banner.");
    expect(html).toContain("Add a slide");
    expect(html).not.toContain('name="slideId"');
    expect(html).toMatch(/<input[^>]*data-slide-picture="wide"[^>]*required=""/);
    // Two-pictures fix: the pictures never travel inside the form (no
    // name); the form carries only their waiting-file names.
    expect(html).not.toMatch(/<input[^>]*type="file"[^>]*name=/);
    expect(html).toContain('<input type="hidden" name="pictureStoragePath"/>');
    expect(html).toContain('<input type="hidden" name="phonePictureStoragePath"/>');
    // Published and pre-order books only, with a price.
    expect(bookFilters).toContainEqual(["in", "status", ["published", "preorder"]]);
    expect(bookFilters).toContainEqual(["not", "price_all", "is", null]);
    expect(html).toContain("Libri B — Autori B (pre-order)");
  });

  it("lists slides in order with status, and the first can't move up nor the last down", async () => {
    slidesRead = {
      data: [slide(SLIDE_1, 1, BOOK_A, { tag: "Ofertë" }), slide(SLIDE_2, 2, "99999999-9999-4999-8999-999999999999")],
      error: null,
    };
    const html = await render();
    expect(html.indexOf("Description 1.")).toBeLessThan(html.indexOf("Description 2."));
    expect(html).toContain("Showing");
    expect(html).toContain("Book not live");
    expect(html).toContain("A book that is not on Libraria now");
    expect(html).toContain("Tag: Ofertë");
    expect(html).toMatch(/disabled=""[^>]*aria-label="Move slide 1 up"/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Move slide 1 down"/);
    expect(html).toMatch(/disabled=""[^>]*aria-label="Move slide 2 down"/);
    expect(html).toContain(`https://cdn.test/libraria/${PIC}`);
  });

  it("?edit= opens that slide in the form; an unknown id keeps the Add form", async () => {
    slidesRead = { data: [slide(SLIDE_1, 1, BOOK_A, { phone_image_path: PIC })], error: null };
    const html = await render({ edit: SLIDE_1 });
    expect(html).toContain("Edit slide");
    expect(html).toContain(`name="slideId" value="${SLIDE_1}"`);
    expect(html).toContain('value="Description 1."');
    expect(html).toContain('name="removePhonePicture"');
    expect(html).toMatch(/<input[^>]*data-slide-picture="wide"/);
    expect(html).not.toMatch(/<input[^>]*data-slide-picture="wide"[^>]*required=""/);
    expect(html).toContain(`<option value="${BOOK_A}" selected="">`);
    expect(await render({ edit: SLIDE_2 })).toContain("Add a slide");
  });

  it("draws a fresh slide form and pick form for each one opened (Edit kept the old book, 2026-11-26)", () => {
    // Edit opens without a reload, and a book list ignores a changed
    // starting value; a new key per slide or pick draws a fresh form.
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(source).toContain('<SlideForm key={editing?.id ?? "new"}');
    expect(source).toContain('<PickForm key={editingPick?.id ?? "new"}');
  });

  it("shows only its own messages", async () => {
    expect(await render({ success: "Category buttons saved." })).toContain("Category buttons saved.");
    expect(await render({ success: "<b>x</b>" })).not.toContain("<b>x</b>");
  });

  // LR1 patch 4: "Çfarë po lexojmë".
  function pick(id: string, bookId: string, publishedAt: string, extra: Record<string, unknown> = {}) {
    return {
      id, book_id: bookId, badge: "Zgjedhja e Librum", note: `Note ${id.slice(0, 1)}.`, quote: "Citim.",
      quote_from: "book", published_at: publishedAt, ...extra,
    };
  }
  const PICK_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const PICK_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const PICK_3 = "ffffffff-ffff-4fff-8fff-ffffffffffff";

  it("no picks: says there is no box, and the Publish form starts with the badge Zgjedhja e Librum (lr4-4 a)", async () => {
    const html = await render();
    expect(html).toContain("No picks yet: Libraria shows no “Çfarë po lexojmë” box.");
    expect(html).toContain("Publish a new pick");
    expect(html).toContain('id="pick-form"');
    expect(html).not.toContain('name="pickId"');
    expect(html).toMatch(/name="badge"[^>]*value="Zgjedhja e Librum"/);
    expect(html).toMatch(/<input(?=[^>]*value="book")(?=[^>]*checked="")[^>]*>/);
    expect(html).toContain(">Publish pick</button>");
    // Between the banner and the category buttons.
    expect(html.indexOf('id="banner-slides"')).toBeLessThan(html.indexOf('id="reading-picks"'));
    expect(html.indexOf('id="reading-picks"')).toBeLessThan(html.indexOf('id="category-buttons"'));
  });

  it("lists picks newest first: on Libraria now, book not live, past (lr4-1 a, lr4-3 a)", async () => {
    picksRead = {
      data: [
        pick(PICK_3, "99999999-9999-4999-8999-999999999999", "2026-11-24T09:00:00Z"),
        pick(PICK_2, BOOK_A, "2026-10-15T09:00:00Z", { badge: null, quote_from: "author" }),
        pick(PICK_1, BOOK_B, "2026-09-20T09:00:00Z"),
      ],
      error: null,
    };
    const html = await render();
    const at = (t: string) => html.indexOf(t);
    expect(at("Note f.")).toBeLessThan(at("Note e."));
    expect(at("Note e.")).toBeLessThan(at("Note d."));
    expect(html).toContain("Book not live");
    expect(html.match(/On Libraria now/g)).toHaveLength(1);
    expect(at("On Libraria now")).toBeGreaterThan(at("Note e."));
    expect(at("On Libraria now")).toBeLessThan(at("Note d."));
    expect(html).toContain("Past pick");
    expect(html).toContain("Nëntor 2026");
    expect(html).toContain("No badge");
    expect(html).toContain("Quote from the author");
    expect(html).toContain(`href="/admin/libraria?pick=${PICK_2}#pick-form"`);
    expect(html).toContain(`name="pickId" value="${PICK_1}"`);
  });

  it("?pick= opens that pick in the form; an unknown id keeps the Publish form", async () => {
    picksRead = { data: [pick(PICK_1, BOOK_A, "2026-09-20T09:00:00Z", { badge: null, quote_from: "author" })], error: null };
    const html = await render({ pick: PICK_1 });
    expect(html).toContain("Edit pick");
    expect(html).toContain(">Save pick</button>");
    expect(html).toMatch(/name="badge"[^>]*value=""/);
    expect(html).toMatch(/<input(?=[^>]*value="author")(?=[^>]*checked="")[^>]*>/);
    expect(html).toContain("Note d.</textarea>");
    expect(await render({ pick: PICK_2 })).toContain("Publish a new pick");
  });

  it("a failed picks read shows no pick list or form; the rest of the page stays", async () => {
    picksRead = { data: null, error: { message: "boom" } };
    const html = await render();
    expect(html).toContain("Couldn’t load the reading picks. Please reload the page.");
    expect(html).not.toContain('id="pick-form"');
    expect(html).toContain('id="banner-form"');
    expect(html).toContain('name="slot1"');
  });
});
