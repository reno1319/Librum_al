import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

// G4 (g4q2 a, g4p1 a): the box reads the staff function and shows each
// failure with a People link and the two buttons; none means nothing; a
// failed read says so.
const mockRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: mockRpc }) }));
vi.mock("./failed-preorder-email-actions", () => ({
  sendFailedPreorderEmailAgain: async () => undefined,
  markFailedPreorderEmailHandled: async () => undefined,
}));

const { FailedPreorderEmails } = await import("./failed-preorder-emails");

const BOOK = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

async function render(): Promise<string> {
  const el = (await FailedPreorderEmails()) as ReactElement | null;
  return el === null ? "" : renderToStaticMarkup(el);
}

describe("FailedPreorderEmails", () => {
  beforeEach(() => {
    mockRpc.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("shows each failure with the reader link and both buttons", async () => {
    mockRpc.mockResolvedValue({
      data: [
        {
          book_id: BOOK,
          user_id: USER,
          book_title: "Pan",
          reader_name: "Arta",
          email_kind: "cancelled",
          send_failure: "batch_refused",
          send_failed_at: "2026-11-24T07:05:00Z",
        },
      ],
      error: null,
    });
    const html = await render();
    expect(mockRpc).toHaveBeenCalledWith("staff_list_preorder_email_failures");
    expect(html).toContain("Failed pre-order emails");
    expect(html).toContain("(1)");
    expect(html).toContain(`href="/admin/people/${USER}"`);
    expect(html).toContain("pre-order cancelled");
    expect(html).toContain("tries again tomorrow");
    expect(html).toContain("Send again");
    expect(html).toContain("Mark handled");
    expect(html).toContain(`value="${BOOK}"`);
  });

  it("shows nothing when no email failed", async () => {
    mockRpc.mockResolvedValue({ data: [], error: null });
    expect(await render()).toBe("");
  });

  it("says so when the read fails", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "42501" } });
    expect(await render()).toContain("Couldn’t load the failed pre-order emails");
  });
});
