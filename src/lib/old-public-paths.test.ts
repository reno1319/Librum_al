import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OLD_PUBLIC_PATHS } from "./old-public-paths";

// ALBANIAN-15: every old English public address redirects permanently
// to an Albanian page that exists, and the English folders are gone.
const app = path.join(__dirname, "..", "app", "(public)");
const firstSegment = (address: string) => address.split("/")[1];

describe("ALBANIAN-15: old public addresses", () => {
  it("each points to a page that exists, permanently", () => {
    expect(OLD_PUBLIC_PATHS).toHaveLength(14);
    for (const rule of OLD_PUBLIC_PATHS) {
      expect(rule.permanent).toBe(true);
      const page = rule.destination.replace("/:path*", "/[id]");
      expect(existsSync(path.join(app, ...page.split("/").filter(Boolean), "page.tsx"))).toBe(true);
      expect(existsSync(path.join(app, firstSegment(rule.source)))).toBe(false);
    }
  });

  it("a sub-path keeps the rest of the address, on both sides or neither", () => {
    for (const rule of OLD_PUBLIC_PATHS) {
      expect(rule.source.endsWith("/:path*")).toBe(rule.destination.endsWith("/:path*"));
    }
  });

  it("/help/reading keeps its own page: its rule comes before /help", () => {
    const sources = OLD_PUBLIC_PATHS.map((rule) => rule.source as string);
    expect(sources.indexOf("/help/reading")).toBeLessThan(sources.indexOf("/help"));
    expect(OLD_PUBLIC_PATHS.find((rule) => rule.source === "/help/reading")?.destination).toBe("/ndihme/leximi");
  });

  it("next.config.ts serves them, and never moves the sign-in, payment, API or admin addresses", () => {
    const config = readFileSync(path.join(__dirname, "..", "..", "next.config.ts"), "utf8");
    expect(config).toContain("...OLD_PUBLIC_PATHS");
    const moved = OLD_PUBLIC_PATHS.map((rule) => firstSegment(rule.source));
    for (const kept of ["auth", "reset-password", "login", "signup", "api", "payments", "admin", "following", "library", "dashboard", "account"]) {
      expect(moved).not.toContain(kept);
    }
  });
});
