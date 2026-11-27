import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Site check-up P3 (11-27): the profile and pen-name photo picker shows an
// Albanian button, never the browser's own "Choose File / No file chosen".
vi.mock("@/lib/supabase/client", () => ({ createClient: vi.fn() }));
const { AvatarField } = await import("./avatar-field");

describe("AvatarField", () => {
  it("hides the browser's file button and shows Zgjidhni foton inside the same label", () => {
    const html = renderToStaticMarkup(createElement(AvatarField, { userId: "u1", existingAvatarUrl: null }));
    expect(html).toMatch(/<label[^>]*>Fotoja \(JPEG ose PNG, deri në 5 MB\)<input type="file"[^>]*class="peer sr-only"/);
    expect(html).toMatch(/<span class="[^"]*peer-focus-visible:[^"]*">Zgjidhni foton<\/span><\/label>/);
    expect(html).not.toContain("file:");
  });
});
