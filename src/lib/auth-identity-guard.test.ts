import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

// PEOPLE-2 guard: the suspension check relies on every page, action and
// route reading identity through auth.getUser(), which asks Supabase
// Auth and so refuses a banned or signed-out session. getSession() and
// getClaims() trust the cookie's token locally and would keep a cut-off
// session working until it expires, so neither may appear in src.
const SRC = path.join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("auth identity guard", () => {
  it("no source file calls getSession() or getClaims()", () => {
    const offenders = sourceFiles(SRC).filter((file) => /\b(getSession|getClaims)\s*\(/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("finds the source tree it is guarding", () => {
    expect(sourceFiles(SRC).some((file) => file.endsWith(path.join("supabase", "middleware.ts")))).toBe(true);
  });
});
