import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// K4 feedback d a: the admin Feedback page. Audit r1 F1: a stored path
// that a browser could read as another site is shown as plain text.
let role = "owner";
const rows = [
  { id: "f1", kind: "problem", body: "Nuk punon.", page_path: "/libra/x", sender_email: "a@example.test", created_at: "2026-11-15T17:40:00Z", done_at: null },
  { id: "f2", kind: "idea", body: "Ide.", page_path: "/\\evil.example", sender_email: null, created_at: "2026-11-14T17:40:00Z", done_at: null },
];
vi.mock("@/lib/staff", () => ({ requireStaff: async () => ({ userId: "u", role }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ rpc: async () => ({ data: rows, error: null }) }) }));
vi.mock("./actions", () => ({ markFeedbackDone: vi.fn(), markSelectedFeedbackDone: vi.fn() }));
const { default: AdminFeedbackPage } = await import("./page");

async function render(search: { status?: string; bulk?: string } = {}) {
  const element = await AdminFeedbackPage({ searchParams: Promise.resolve(search) });
  return renderToStaticMarkup(element);
}

describe("admin Feedback page", () => {
  it("links a clean path, shows an unsafe one as text, and names the sender", async () => {
    role = "owner";
    const html = await render();
    expect(html).toContain('href="/libra/x"');
    expect(html).not.toContain('href="/\\evil.example"');
    expect(html).toContain('<span data-unsafe-path="">/\\evil.example</span>');
    expect(html).toContain("mailto:a@example.test");
    expect(html).toContain("a deleted account");
    expect(html).toContain("2 open messages from readers");
    expect(html).toContain("Mark done");
  });

  it("hides Mark done without reports.resolve", async () => {
    role = "support";
    expect(await render()).not.toContain("Mark done");
  });

  it("shows a moderator no sender line (audit r1 F2, mod a)", async () => {
    role = "moderator";
    const html = await render();
    expect(html).toContain("Mark done");
    expect(html).not.toContain("From:");
    expect(html).not.toContain("mailto:");
  });

  it("G4 batch 3: a tick box per open message and the Mark selected done bar, only with reports.resolve", async () => {
    role = "owner";
    const html = await render();
    expect(html).toContain("Mark selected done (0)");
    expect(html).toContain('form="bulk-feedback-done"');
    expect(html).toContain('value="f1"');
    expect(html).toContain('name="status" value="open"');
    role = "support";
    const support = await render();
    expect(support).not.toContain("Mark selected done");
    expect(support).not.toContain('name="pick"');
  });

  it("G4 batch 3 (b3e1 a): after Mark selected done, the green and red lines from digits only", async () => {
    role = "owner";
    const html = await render({ bulk: "3.0.1" });
    expect(html).toContain("3 messages marked done.");
    expect(html).toContain("1 not marked done: something went wrong. It stays in Open; try again.");
    expect(await render({ bulk: "x" })).not.toContain("marked done.");
  });
});
