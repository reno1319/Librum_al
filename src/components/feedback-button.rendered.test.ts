import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// K4 feedback button: closed by default, a 48px round button with a name.
vi.mock("next/navigation", () => ({ usePathname: () => "/libra/x" }));
vi.mock("@/app/(public)/feedback-actions", () => ({ sendFeedback: vi.fn() }));
const { FeedbackButton } = await import("./feedback-button");

describe("FeedbackButton", () => {
  it("starts closed: only the corner button, named for screen readers", () => {
    const html = renderToStaticMarkup(createElement(FeedbackButton));
    expect(html).toContain('data-feedback-fab=""');
    expect(html).toContain('aria-label="Na tregoni: problem ose ide"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("size-12");
    expect(html).not.toContain('role="dialog"');
  });
});
