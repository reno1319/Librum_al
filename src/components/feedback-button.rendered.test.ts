import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// K4 feedback button: closed by default, a 48px round button with a name.
vi.mock("next/navigation", () => ({ usePathname: () => "/libra/x" }));
vi.mock("@/app/(public)/feedback-actions", () => ({ sendFeedback: vi.fn() }));
const { FeedbackButton, feedbackFabHidden } = await import("./feedback-button");

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

// fb1 a: on phones it hides while scrolling down, returns on scroll up,
// near the top and at the end of the page.
describe("feedbackFabHidden", () => {
  const at = (previousY: number, y: number, wasHidden = false) =>
    feedbackFabHidden({ previousY, y, viewportHeight: 844, pageHeight: 4000, wasHidden });

  it("hides while scrolling down", () => {
    expect(at(500, 600)).toBe(true);
  });
  it("comes back on scroll up", () => {
    expect(at(600, 500, true)).toBe(false);
  });
  it("ignores tiny movements either way", () => {
    expect(at(600, 605, true)).toBe(true);
    expect(at(600, 595, false)).toBe(false);
  });
  it("always shows near the top", () => {
    expect(at(0, 60)).toBe(false);
  });
  it("always shows at the end of the page", () => {
    expect(at(3000, 3150)).toBe(false);
  });
  it("starts visible, not tucked away", () => {
    const html = renderToStaticMarkup(createElement(FeedbackButton));
    expect(html).not.toContain("data-hidden");
    expect(html).not.toContain("opacity-0");
  });
});
