import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// iPhone step (I1, I1b): iOS Safari zooms the page when a focused field's
// text is under 16px. One unlayered phone-only rule in globals.css sets
// fields to 16px (it must sit outside every @layer to beat Tailwind's
// text-sm), the 18px price boxes keep 18px, and nothing blocks pinch zoom.

const SRC = join(__dirname, "..");
const css = readFileSync(join(__dirname, "globals.css"), "utf8");
// LEFTOVERS (L4): Tailwind's sm breakpoint unit, as a range query (the
// built CSS is checked after `next build`, not here).
const RULE_MEDIA = "@media (width < 40rem)";

/** The at-rule preludes enclosing `index` in `text` (comments stripped). */
function enclosingBlocks(text: string, index: number): string[] {
  const stack: string[] = [];
  let preludeStart = 0;
  for (let i = 0; i < index; i++) {
    if (text[i] === "{") {
      stack.push(text.slice(preludeStart, i).trim());
      preludeStart = i + 1;
    } else if (text[i] === "}") {
      stack.pop();
      preludeStart = i + 1;
    } else if (text[i] === ";") {
      preludeStart = i + 1;
    }
  }
  return stack;
}

describe("globals.css: phone field text is 16px (I1)", () => {
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  const mediaAt = plain.indexOf(RULE_MEDIA);
  const block = plain.slice(mediaAt, plain.indexOf("}", plain.indexOf("{", plain.indexOf("{", mediaAt) + 1)) + 1);

  it("has exactly one rule under width < 40rem", () => {
    expect(mediaAt).toBeGreaterThan(-1);
    expect(plain.indexOf(RULE_MEDIA, mediaAt + 1)).toBe(-1);
  });

  it("sits outside any @layer (unlayered, so text-sm can't win)", () => {
    expect(enclosingBlocks(plain, mediaAt)).toEqual([]);
  });

  it("sets 16px on text inputs, selects and textareas, skipping .text-lg, radios, checkboxes, file and range", () => {
    expect(block).toContain(
      'input:not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="range"]):not(.text-lg)',
    );
    expect(block).toMatch(/select:not\(\.text-lg\)\s*,/);
    expect(block).toMatch(/textarea:not\(\.text-lg\)\s*\{/);
    expect(block).toMatch(/\{\s*font-size: 16px;\s*\}/);
  });
});

describe("no viewport blocks pinch zoom (I1)", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  it("no source sets maximum-scale or user-scalable", () => {
    const offenders = sourceFiles(SRC).filter((f) =>
      /maximum-?scale|user-?scalable/i.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("Bookstore filter row is 16px on phones, 14px from 640px (I1b)", () => {
  it("FILTER_CONTROL_CLASSES uses text-base sm:text-sm, not a bare text-sm", () => {
    const page = readFileSync(join(__dirname, "(public)/librari/page.tsx"), "utf8");
    const at = page.indexOf("const FILTER_CONTROL_CLASSES =");
    const classes = page.slice(at, page.indexOf(";", at)).match(/"([^"]*)"/)![1].split(" ");
    expect(classes).toContain("text-base");
    expect(classes).toContain("sm:text-sm");
    expect(classes).not.toContain("text-sm");
  });
});
