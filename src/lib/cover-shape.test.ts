import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Book covers are shown in 5:8 (1 : 1,6) boxes -- the shape the upload
// hint asks for -- and are never cropped: object-contain, so a cover in
// any other shape (square, landscape) shows whole, bottom-aligned, with
// see-through space above it and the shadow on the image (drop-shadow).
function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("book cover shape", () => {
  const lines = tsxFiles("src").flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((text, i) => ({ where: `${file}:${i + 1}`, text })),
  );

  it("no box uses the old 2:3 shape", () => {
    expect(lines.filter((l) => l.text.includes("aspect-[2/3]")).map((l) => l.where)).toEqual([]);
  });

  it("no cover box crops its image", () => {
    expect(
      lines.filter((l) => l.text.includes("aspect-[5/8]") && l.text.includes("object-cover")).map((l) => l.where),
    ).toEqual([]);
  });
});
