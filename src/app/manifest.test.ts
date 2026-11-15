import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import manifest from "./manifest";

vi.mock("next/font/google", () => {
  const font = () => ({ className: "f", variable: "--f" });
  return { Libre_Franklin: font, Geist_Mono: font, Libre_Caslon_Text: font };
});
const { metadata } = await import("./layout");

// K9 (Renato 11-14, 2a): Librum as a home-screen app. Icon only: no
// service worker, nothing stored for offline reading.
describe("app manifest", () => {
  const m = manifest();

  it("opens Librum full-screen from the homepage", () => {
    expect(m).toMatchObject({ name: "Librum", short_name: "Librum", lang: "sq", start_url: "/", scope: "/", display: "standalone" });
  });

  it("has a 192, a 512 and a maskable 512 icon, all in public/icons", () => {
    expect(m.icons?.map((i) => `${i.sizes} ${i.purpose}`)).toEqual(["192x192 any", "512x512 any", "512x512 maskable"]);
    for (const icon of m.icons ?? []) expect(existsSync(`public${icon.src}`)).toBe(true);
  });

  it("gives iPhone its home-screen icon and name", () => {
    expect(metadata.icons).toEqual({ apple: "/icons/apple-touch-icon.png" });
    expect(existsSync("public/icons/apple-touch-icon.png")).toBe(true);
    expect(metadata.appleWebApp).toMatchObject({ capable: true, title: "Librum" });
  });

  it("adds no service worker (no offline copies of books)", () => {
    expect(existsSync("public/sw.js")).toBe(false);
    expect(existsSync("src/app/sw.ts")).toBe(false);
  });
});
