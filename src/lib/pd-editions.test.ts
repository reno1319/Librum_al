import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  PD_ALREADY_HAVE_NOTE,
  PD_PICKED_LINE,
  PD_PREPARED_BY,
  PD_REPLACED_LINE,
  isPickedPdEdition,
  isReplacedPdEdition,
  pdFrozenDetailsUnchanged,
  pdShelfLine,
  readPdEditionRedirect,
  showsPreparedBy,
} from "@/lib/pd-editions";
import { shelfMenuItems } from "@/lib/bookshelf";

// BD15 P7 (migration 20261105180000; Renato 11-05, Q1-Q4 a).
const WORK = "55555555-5555-4555-8555-555555555555";
const BOOK = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const SRC = path.resolve(__dirname, "..");
const read = (rel: string) => readFileSync(path.join(SRC, rel), "utf8");

describe("the author's view of an edition", () => {
  it("a live linked book is its work's picked edition (LB485 allows no other)", () => {
    expect(isPickedPdEdition({ status: "published", published_at: "2026-11-05", pd_work_id: WORK })).toBe(true);
    expect(isPickedPdEdition({ status: "published", published_at: "2026-11-05", pd_work_id: null })).toBe(false);
    expect(isPickedPdEdition({ status: "draft", published_at: null, pd_work_id: WORK })).toBe(false);
  });

  it("Q2 a: a linked draft that was published once and is not taken down was replaced", () => {
    expect(isReplacedPdEdition({ status: "draft", published_at: "2026-11-05", pd_work_id: WORK }, false)).toBe(true);
    expect(isReplacedPdEdition({ status: "draft", published_at: "2026-11-05", pd_work_id: WORK }, true)).toBe(false);
    expect(isReplacedPdEdition({ status: "draft", published_at: null, pd_work_id: WORK }, false)).toBe(false);
    expect(isReplacedPdEdition({ status: "draft", published_at: "2026-11-05", pd_work_id: null }, false)).toBe(false);
  });

  it("the shelf line says which", () => {
    expect(pdShelfLine({ status: "published", published_at: "x", pd_work_id: WORK }, false)).toBe(PD_PICKED_LINE);
    expect(pdShelfLine({ status: "draft", published_at: "x", pd_work_id: WORK }, false)).toBe(PD_REPLACED_LINE);
    expect(pdShelfLine({ status: "published", published_at: "x" }, false)).toBeNull();
    expect(PD_REPLACED_LINE).toBe("Librum zgjodhi një botim tjetër të kësaj vepre.");
    expect(PD_ALREADY_HAVE_NOTE).toBe("Librum ka tashmë një botim të kësaj vepre.");
  });

  it("Q1 a: a picked edition's shelf menu has no unpublish and no series move", () => {
    const picked = shelfMenuItems({ state: "live", status: "published", hasFile: true, pdPicked: true });
    expect(picked).not.toContain("unpublish");
    expect(picked).not.toContain("series");
    expect(picked).not.toContain("delete");
    expect(picked).toContain("edit_content");
    const normal = shelfMenuItems({ state: "live", status: "published", hasFile: true });
    expect(normal).toContain("unpublish");
    expect(normal).toContain("series");
  });
});

describe("audit r1 N2: a no-op save of a picked edition", () => {
  const stored = {
    subtitle: "  Nën  titull ",
    language: null,
    series_id: null,
    series_position: null,
    edition_number: null,
    reading_age_min: null,
    categories: ["Poezi"],
    keywords: "a,b, A",
  };
  const form = {
    subtitle: "Nën titull",
    language: "sq",
    series_id: null,
    series_position: null,
    edition_number: null,
    reading_age_min: null,
    categories: ["Poezi"],
    keywords: "a, b",
  };
  it("is unchanged when only the spelling differs", () => {
    expect(pdFrozenDetailsUnchanged(stored, form)).toBe(true);
    const { reading_age_min: _ignored, ...withoutAge } = form;
    expect(pdFrozenDetailsUnchanged({ ...stored, reading_age_min: 12 }, withoutAge)).toBe(true);
  });
  it("is changed by any real change", () => {
    for (const change of [
      { subtitle: "Tjetër" },
      { language: "en" },
      { series_id: OTHER },
      { series_position: 2 },
      { edition_number: 2 },
      { reading_age_min: 12 },
      { categories: ["Romancë"] },
      { keywords: "a, c" },
    ]) {
      expect(pdFrozenDetailsUnchanged(stored, { ...form, ...change })).toBe(false);
    }
  });
});

describe("the book page", () => {
  it("Q4 a: 'Përgatiti për botim' only with the editor mention", () => {
    expect(PD_PREPARED_BY).toBe("Përgatiti për botim:");
    expect(showsPreparedBy({ pd_work_id: WORK, pd_editor_credit: true })).toBe(true);
    expect(showsPreparedBy({ pd_work_id: WORK, pd_editor_credit: false })).toBe(false);
    expect(showsPreparedBy({ pd_work_id: null, pd_editor_credit: true })).toBe(false);
  });

  it("the redirect read returns only another book's id, and fails to null", async () => {
    const rpc = vi.fn();
    const client = { rpc } as never;
    rpc.mockResolvedValueOnce({ data: OTHER, error: null });
    expect(await readPdEditionRedirect(client, BOOK)).toBe(OTHER);
    expect(rpc).toHaveBeenCalledWith("pd_edition_redirect", { p_book_id: BOOK });
    rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await readPdEditionRedirect(client, BOOK)).toBeNull();
    rpc.mockResolvedValueOnce({ data: BOOK, error: null });
    expect(await readPdEditionRedirect(client, BOOK)).toBeNull();
    rpc.mockResolvedValueOnce({ data: "javascript:alert(1)", error: null });
    expect(await readPdEditionRedirect(client, BOOK)).toBeNull();
    rpc.mockResolvedValueOnce({ data: OTHER, error: { code: "42501" } });
    expect(await readPdEditionRedirect(client, BOOK)).toBeNull();
    rpc.mockRejectedValueOnce(new Error("network"));
    expect(await readPdEditionRedirect(client, BOOK)).toBeNull();
    rpc.mockClear();
    expect(await readPdEditionRedirect(client, "not-a-uuid")).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("redirects only where the page would be 'not found', and hides an empty About the author", () => {
    const page = read("app/(public)/libra/[id]/page.tsx");
    expect(page.match(/return notFoundOrPickedEdition\(\);/g)).toHaveLength(2);
    expect(page).toContain("if (picked) redirect(`/libra/${picked}`);");
    expect(page).toContain("{book.pen && (\n      <section className={PAGE_SECTION_CLASSES}>");
    expect(page).toContain("{showsPreparedBy(book) && authorName && (");
    // No `.eq("pen_name_id", null)` for an edition without a pen name.
    expect(page).toContain("book.pen_name_id\n      ? supabase");
  });
});

describe("HARD GATE: the pen-name embed", () => {
  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(full);
    }
    return out;
  }

  it("books has two keys to pen_names now, so every embed of pen_names (not the view) names books_pen_name_id_fkey", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/[\s:,"'`(]pen_names(!?[a-z_]*)\(/g)) {
        if (match[1] !== "!books_pen_name_id_fkey") offenders.push(`${path.relative(SRC, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the migration keeps public_books.pen_name_id a plain column with its own key", () => {
    const migration = readFileSync(
      path.resolve(SRC, "../supabase/migrations/20261105180000_bd15_pd_editions.sql"),
      "utf8",
    );
    const view = migration.slice(migration.indexOf("create or replace view public.public_books"), migration.indexOf("from public.books b"));
    expect(view).toContain("b.public_pen_name_id as pen_name_id,");
    expect(view.replace(/--.*$/gm, "")).not.toMatch(/\bcase\b/i);
    expect(migration).toContain("constraint books_public_pen_name_id_fkey references public.pen_names(id)");
  });
});
