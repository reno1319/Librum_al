import { beforeEach, describe, expect, it, vi } from "vitest";
import { attachPenNames, resolveBookByline } from "./book-byline";
import { resetSchemaFeatureOffLogForTests } from "./schema-feature-off";

describe("resolveBookByline", () => {
  const profile = { display_name: "Renato Kalemi", public_author_name: "Arben Leka" };

  it("a book with a pen name shows the pen name, not the author's public name", () => {
    expect(resolveBookByline({ pen_name: "Ëngjëll Çela" }, profile)).toBe("Ëngjëll Çela");
  });

  it("a null pen name falls back to the author's public name", () => {
    expect(resolveBookByline({ pen_name: null }, profile)).toBe("Arben Leka");
  });

  it("a row read before the migration (no pen_name key) behaves like null", () => {
    expect(resolveBookByline({}, profile)).toBe("Arben Leka");
  });

  it("falls back through public_author_name to display_name, as today", () => {
    expect(
      resolveBookByline({ pen_name: null }, { display_name: "Renato Kalemi", public_author_name: null }),
    ).toBe("Renato Kalemi");
  });

  it("a view-shaped profile (no display_name) never recovers a private name", () => {
    expect(resolveBookByline({ pen_name: null }, { public_author_name: null })).toBeNull();
  });

  it("the pen name wins even when no profile was loaded", () => {
    expect(resolveBookByline({ pen_name: "Jo Pen" }, null)).toBe("Jo Pen");
  });

  it("no book and no profile: null, never throws", () => {
    expect(resolveBookByline(null, undefined)).toBeNull();
  });
});

// F4 (P5): the one extra read for pages whose book query names its columns.
describe("attachPenNames", () => {
  type Answer = { data: unknown; error: { code?: string; message?: string } | null };
  function reader(answer: Answer | (() => never)) {
    const calls: unknown[][] = [];
    const client = {
      from(table: "books") {
        calls.push(["from", table]);
        return {
          select(columns: "id, pen_name") {
            calls.push(["select", columns]);
            return {
              in(column: "id", values: string[]) {
                calls.push(["in", column, values]);
                return typeof answer === "function" ? Promise.reject(new Error("network")) : Promise.resolve(answer);
              },
            };
          },
        };
      },
    };
    return { client, calls };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    resetSchemaFeatureOffLogForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  const books = [
    { id: "b1", title: "One" },
    { id: "b2", title: "Two" },
    { id: "b1", title: "One again" },
  ];

  it("one query over the distinct ids, and each book gets its own pen name", async () => {
    const { client, calls } = reader({ data: [{ id: "b1", pen_name: "Jo Pen" }, { id: "b2", pen_name: null }], error: null });
    const result = await attachPenNames(client, books);
    expect(calls).toEqual([["from", "books"], ["select", "id, pen_name"], ["in", "id", ["b1", "b2"]]]);
    expect(result.map((b) => b.pen_name)).toEqual(["Jo Pen", null, "Jo Pen"]);
    expect(result[1].title).toBe("Two");
  });

  it("no books -> no query", async () => {
    const { client, calls } = reader({ data: [], error: null });
    expect(await attachPenNames(client, [])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it.each(["42703", "PGRST204"])("before the migration (%s) -> the books unchanged, logged once as feature off", async (code) => {
    const { client } = reader({ data: null, error: { code, message: "column books.pen_name does not exist" } });
    expect(await attachPenNames(client, books)).toBe(books);
    expect(await attachPenNames(client, books)).toBe(books);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("any other error, or a thrown request -> the books unchanged, logged", async () => {
    expect(await attachPenNames(reader({ data: null, error: { code: "08006" } }).client, books)).toBe(books);
    expect(await attachPenNames(reader(() => { throw new Error(); }).client, books)).toBe(books);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("the bylines then fall back to the author's public name", async () => {
    const { client } = reader({ data: null, error: { code: "42703" } });
    const [book] = await attachPenNames(client, [{ id: "b1" }]);
    expect(resolveBookByline(book, { public_author_name: "Arben Leka" })).toBe("Arben Leka");
  });
});
