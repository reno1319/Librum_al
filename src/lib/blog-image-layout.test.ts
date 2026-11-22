import { describe, expect, it } from "vitest";
import { blogImageLayoutClass, joinBlogImageSrc, splitBlogImageSrc } from "./blog-image-layout";

describe("blog picture size and position (img1 a, img3 a)", () => {
  it("an address with no # is Full, as before", () => {
    expect(splitBlogImageSrc("https://x.test/a.jpg")).toEqual({ url: "https://x.test/a.jpg", layout: { size: "full", pos: "centre" } });
  });

  it("reads size and position after #", () => {
    expect(splitBlogImageSrc("https://x.test/a.jpg#size=half&pos=left")).toEqual({ url: "https://x.test/a.jpg", layout: { size: "half", pos: "left" } });
    expect(splitBlogImageSrc("https://x.test/a.jpg#pos=right&size=small").layout).toEqual({ size: "small", pos: "right" });
  });

  it("ignores anything it does not know, and Full is always centred", () => {
    expect(splitBlogImageSrc("https://x.test/a.jpg#size=huge&pos=top").layout).toEqual({ size: "full", pos: "centre" });
    expect(splitBlogImageSrc("https://x.test/a.jpg#size=full&pos=left").layout).toEqual({ size: "full", pos: "centre" });
    expect(splitBlogImageSrc("https://x.test/a.jpg#size=half").layout).toEqual({ size: "half", pos: "centre" });
    expect(splitBlogImageSrc("https://x.test/a.jpg#<script>").layout).toEqual({ size: "full", pos: "centre" });
  });

  it("saves Full with no #, and replaces an old #", () => {
    expect(joinBlogImageSrc("https://x.test/a.jpg#size=half&pos=left", { size: "full", pos: "left" })).toBe("https://x.test/a.jpg");
    expect(joinBlogImageSrc("https://x.test/a.jpg#size=half&pos=left", { size: "small", pos: "right" })).toBe("https://x.test/a.jpg#size=small&pos=right");
  });

  it("round-trips every size and position", () => {
    for (const size of ["full", "half", "small"] as const) {
      for (const pos of ["left", "centre", "right"] as const) {
        const src = joinBlogImageSrc("https://x.test/a.jpg", { size, pos });
        expect(splitBlogImageSrc(src).layout).toEqual({ size, pos: size === "full" ? "centre" : pos });
      }
    }
  });

  it("wraps only from 640 px up; on a phone every picture is full width", () => {
    expect(blogImageLayoutClass({ size: "full", pos: "centre" })).toBe("mt-4 block clear-both");
    const halfLeft = blogImageLayoutClass({ size: "half", pos: "left" });
    expect(halfLeft).toContain("w-full");
    expect(halfLeft).toContain("sm:w-1/2");
    expect(halfLeft).toContain("sm:float-left");
    expect(halfLeft).not.toMatch(/(^| )float-/);
    expect(blogImageLayoutClass({ size: "small", pos: "right" })).toContain("sm:float-right");
    expect(blogImageLayoutClass({ size: "small", pos: "right" })).toContain("sm:w-1/3");
    expect(blogImageLayoutClass({ size: "half", pos: "centre" })).toContain("sm:mx-auto");
    expect(blogImageLayoutClass({ size: "half", pos: "centre" })).not.toContain("float");
  });
});
