import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// BD15 P5b-3a: the old edit page is retired; the route only sends old
// links and bookmarks to the book's editor, which checks the session and
// ownership itself.

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const { default: EditBookPage } = await import("./page");
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";

describe("the retired edit page", () => {
  it("sends the book to its editor", async () => {
    await expect(EditBookPage({ params: Promise.resolve({ id: BOOK_ID }) })).rejects.toThrow(
      `REDIRECT:/dashboard/books/${BOOK_ID}/editor?tab=details`,
    );
  });

  it("a malformed id is not found (no redirect built from it)", async () => {
    await expect(EditBookPage({ params: Promise.resolve({ id: "../x" }) })).rejects.toThrow("NOT_FOUND");
  });

  it("reads nothing and offers no action of its own", () => {
    const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(source).not.toContain("supabase");
    expect(source).not.toContain("action=");
    expect(source).not.toContain("../../actions");
  });
});
