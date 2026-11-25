import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// LR1 patch 2 (lb5 a): the admin Libraria page.
class RedirectSignal extends Error {}
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));
vi.mock("./actions", () => ({ saveCategoryButtons: vi.fn() }));

let read: { data: unknown; error: { message: string } | null };
const reads: string[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      from: (table: string) => {
        reads.push(table);
        const chain = { select: () => chain, order: () => chain, returns: () => Promise.resolve(read) };
        return chain;
      },
    }),
}));

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
    read = { data: [{ position: 1, category: "Romancë" }, { position: 2, category: "Poezi" }], error: null };
  });

  it("gates on catalog.feature and reads nothing when denied", async () => {
    mockRequireStaff.mockRejectedValueOnce(new RedirectSignal("/admin"));
    await expect(render()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("catalog.feature");
    expect(reads).toEqual([]);
  });

  it("six ordered dropdowns, filled with staff's list, the rest None", async () => {
    const html = await render();
    expect(reads).toEqual(["libraria_category_buttons"]);
    for (let i = 1; i <= 6; i++) expect(html).toContain(`name="slot${i}"`);
    expect(html).not.toContain('name="slot7"');
    expect(html.match(/<option value="Romancë" selected="">/g)).toHaveLength(1);
    expect(html.match(/<option value="Poezi" selected="">/g)).toHaveLength(1);
    expect(html.match(/<option value="" selected="">None<\/option>/g)).toHaveLength(4);
  });

  it("a failed read shows no form", async () => {
    read = { data: null, error: { message: "boom" } };
    const html = await render();
    expect(html).toContain("Couldn’t load the category buttons. Please reload the page.");
    expect(html).not.toContain("<form");
  });

  it("shows only its own messages", async () => {
    expect(await render({ success: "Category buttons saved." })).toContain("Category buttons saved.");
    expect(await render({ success: "<b>x</b>" })).not.toContain("<b>x</b>");
  });
});
