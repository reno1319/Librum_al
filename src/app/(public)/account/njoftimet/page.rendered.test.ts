import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BD16 P4 (D8): "Njoftimet e mia" lists only the reader's waiting
// notices for live pre-orders, newest first, each with "Hiq".

const mockCreateClient = vi.fn((): unknown => null);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));
vi.mock("@/app/(public)/libra/[id]/preorder-actions", () => ({ removePreorderNotice: vi.fn() }));

const { default: MyNoticesPage } = await import("./page");

type Call = [string, unknown[]];
function queryStub(result: unknown, log: Call[]) {
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(result);
      return (...args: unknown[]) => (log.push([String(prop), args]), chain);
    },
  });
  return chain;
}

const A = "00000000-f1c9-4000-8000-0000000016a1";
const B = "00000000-f1c9-4000-8000-0000000016b2";
const C = "00000000-f1c9-4000-8000-0000000016c3";

async function render(user: { id: string } | null) {
  const logs: Record<string, Call[]> = { preorder_notify_requests: [], public_books: [] };
  mockCreateClient.mockImplementation(() => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => {
      if (table === "preorder_notify_requests") {
        return queryStub(
          {
            data: [
              { book_id: B, notified_at: null, book_cancelled_at: null },
              { book_id: C, notified_at: null, book_cancelled_at: "2026-11-01T07:00:00Z" },
              { book_id: A, notified_at: null, book_cancelled_at: null },
            ],
          },
          logs.preorder_notify_requests,
        );
      }
      return queryStub(
        {
          data: [
            { id: A, title: "Libri A", status: "preorder", release_date: "2099-12-12", pen_name_id: null, original_author: null, pen: { id: "p", name: "Ana" } },
            { id: B, title: "Libri B", status: "preorder", release_date: "2020-01-01", pen_name_id: null, original_author: null, pen: null },
          ],
        },
        logs.public_books,
      );
    },
  }));
  const element = await MyNoticesPage({ searchParams: Promise.resolve({}) });
  return { html: renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]), logs };
}

describe("Njoftimet e mia", () => {
  it("sends a visitor to sign in", async () => {
    await expect(render(null)).rejects.toThrow("REDIRECT /login?next=/account/njoftimet");
  });

  it("reads own rows, then only live pre-orders, and leaves out cancelled ones", async () => {
    const { html, logs } = await render({ id: "00000000-0000-4000-8000-0000000000b2" });
    expect(logs.preorder_notify_requests).toContainEqual(["eq", ["user_id", "00000000-0000-4000-8000-0000000000b2"]]);
    expect(logs.public_books).toContainEqual(["in", ["id", [B, A]]]);
    expect(logs.public_books).toContainEqual(["eq", ["status", "preorder"]]);
    expect(html.indexOf("Libri B")).toBeLessThan(html.indexOf("Libri A"));
    expect(html).toContain("Del më 12 dhjetor 2099");
    expect(html).toContain("Del së shpejti");
    expect(html.match(/Hiq njoftimin/g)).toHaveLength(2);
  });
});
