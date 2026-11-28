import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Amazon book page P3 (bp4 a): the all-reviews page -- 10 per page,
// the star filter, and the book page's visibility gate.

const mockCreateClient = vi.fn((): unknown => {
  throw new Error("createClient not stubbed");
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const notFoundError = new Error("NEXT_NOT_FOUND");
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw notFoundError;
  },
}));

const { default: BookReviewsPage } = await import("./page");

const BOOK_ID = "11111111-1111-4111-8111-111111111111";
const review = (n: number, rating: number) => ({
  id: `r${n}`, book_id: BOOK_ID, rating, body: `Text ${n}`, created_at: "2026-11-01T10:00:00Z",
  reviewer_name: `Reader ${n}`, verified: false, reviewer_is_author: false,
});

type Opts = {
  status?: string;
  ratings?: number[];
  total?: number;
  pageRows?: unknown[];
  user?: { id: string } | null;
  isAuthor?: boolean;
  owns?: boolean;
};

function setup(opts: Opts) {
  const listCalls: { method: string; args: unknown[] }[][] = [];
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user: opts.user ?? null } }) },
    rpc: async () => ({ data: opts.owns ?? false }),
    from: (table: string) => {
      const calls: { method: string; args: unknown[] }[] = [];
      let single = false;
      const resolve = () => {
        if (table === "public_books") return { data: { id: BOOK_ID, title: "Test Book", status: opts.status ?? "published" } };
        if (table === "books") return { data: opts.isAuthor ? { id: BOOK_ID } : null };
        if (table === "public_reviews") {
          const select = calls.find((c) => c.method === "select");
          if (select?.args[0] === "rating") return { data: (opts.ratings ?? []).map((rating) => ({ rating })) };
          return { data: opts.pageRows ?? [], count: opts.total ?? 0 };
        }
        return { data: single ? null : [] };
      };
      if (table === "public_reviews") listCalls.push(calls);
      const chain: Record<string, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (done: (v: unknown) => unknown) => done(resolve());
          if (prop === "single" || prop === "maybeSingle") return () => ((single = true), chain);
          return (...args: unknown[]) => (calls.push({ method: String(prop), args }), chain);
        },
      });
      return chain;
    },
  }));
  return listCalls;
}

async function render(searchParams: Record<string, string> = {}) {
  const element = await BookReviewsPage({ params: Promise.resolve({ id: BOOK_ID }), searchParams: Promise.resolve(searchParams) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

beforeEach(() => {
  vi.unstubAllEnvs();
  mockCreateClient.mockReset();
});

describe("all-reviews page", () => {
  it("first page: 10 newest, rows link to the filter, 'Faqja 1 nga 3' with a next link only", async () => {
    const calls = setup({ ratings: [5, 5, 4, 1], total: 25, pageRows: Array.from({ length: 10 }, (_, i) => review(i, 5)) });
    const html = await render();
    expect((html.match(/data-review=""/g) ?? []).length).toBe(10);
    expect(html).toContain("Më të rejat · 25 vlerësime");
    expect(html).toContain(`href="/libra/${BOOK_ID}/vleresimet?yjet=5"`);
    expect(html).toContain("Faqja 1 nga 3");
    expect(html).toContain(`href="/libra/${BOOK_ID}/vleresimet?faqja=2"`);
    expect(html).not.toContain("Më parë");
    const list = calls.find((c) => c.some((x) => x.method === "range"))!;
    expect(list.find((x) => x.method === "range")!.args).toEqual([0, 9]);
    expect(list.some((x) => x.method === "eq" && x.args[0] === "rating")).toBe(false);
  });

  it("star filter: only that rating is asked for, the row is marked, pages keep the filter, 'Shiko të gjitha' clears it", async () => {
    const calls = setup({ ratings: [5, 4, 4], total: 12, pageRows: [review(1, 4), review(2, 4)] });
    const html = await render({ yjet: "4", faqja: "2" });
    const list = calls.find((c) => c.some((x) => x.method === "range"))!;
    expect(list.some((x) => x.method === "eq" && x.args[0] === "rating" && x.args[1] === 4)).toBe(true);
    expect(list.find((x) => x.method === "range")!.args).toEqual([10, 19]);
    expect(html).toContain("Vetëm 4 yje · 12 vlerësime");
    expect(html).toMatch(/aria-current="true"[^>]*>4 yje</);
    expect(html).toContain(`href="/libra/${BOOK_ID}/vleresimet?yjet=4"`);
    expect(html).toContain("Faqja 2 nga 2");
    expect(html).toContain(">Shiko të gjitha<");
  });

  it("a page past the end, or a bad page number, is not found", async () => {
    setup({ ratings: [5], total: 1, pageRows: [] });
    await expect(render({ faqja: "2" })).rejects.toBe(notFoundError);
    await expect(render({ faqja: "x" })).rejects.toBe(notFoundError);
  });

  it("a book that is not live: not found for others, shown to its author or a reader who owns it", async () => {
    setup({ status: "draft", user: { id: "someone" } });
    await expect(render()).rejects.toBe(notFoundError);
    setup({ status: "draft", user: null });
    await expect(render()).rejects.toBe(notFoundError);
    setup({ status: "draft", user: { id: "a" }, isAuthor: true });
    expect(await render()).toContain("Vlerësimet e lexuesve");
    setup({ status: "draft", user: { id: "r" }, owns: true });
    expect(await render()).toContain("Vlerësimet e lexuesve");
    setup({ status: "preorder" });
    expect(await render()).toContain("Vlerësimet e lexuesve");
  });

  it("no reviews yet", async () => {
    setup({ ratings: [], total: 0 });
    const html = await render();
    expect(html).toContain("Ende pa vlerësime.");
    expect(html).not.toContain("data-review-histogram");
  });
});
