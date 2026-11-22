import { describe, expect, it } from "vitest";
import { initialCropFrame, moveCropFrame, outputSize, toSourceRect } from "./image-crop";

describe("picture crop (img2 a)", () => {
  it("Original is the whole picture", () => {
    expect(initialCropFrame(600, 400, "original")).toEqual({ x: 0, y: 0, width: 600, height: 400 });
  });

  it("Tall 2:3 on a wide picture uses the full height, centred", () => {
    expect(initialCropFrame(600, 400, "tall")).toEqual({ x: 300 - 400 * (2 / 3) / 2, y: 0, width: 400 * (2 / 3), height: 400 });
  });

  it("Square and Wide 3:2 fit inside the picture", () => {
    expect(initialCropFrame(600, 400, "square")).toEqual({ x: 100, y: 0, width: 400, height: 400 });
    expect(initialCropFrame(400, 600, "wide")).toEqual({ x: 0, y: (600 - 400 / 1.5) / 2, width: 400, height: 400 / 1.5 });
  });

  it("the frame cannot be dragged outside the picture", () => {
    const f = initialCropFrame(600, 400, "square");
    expect(moveCropFrame(f, -500, 50, 600, 400)).toEqual({ x: 0, y: 0, width: 400, height: 400 });
    expect(moveCropFrame(f, 500, 0, 600, 400).x).toBe(200);
  });

  it("turns the frame on screen into real pixels", () => {
    expect(toSourceRect({ x: 50, y: 10, width: 200, height: 300 }, 600, 1800, 1200)).toEqual({ x: 150, y: 30, width: 600, height: 900 });
    expect(toSourceRect({ x: 599, y: 0, width: 10, height: 10 }, 600, 600, 400)).toEqual({ x: 599, y: 0, width: 1, height: 10 });
  });

  it("the saved copy is never wider than 2400 px", () => {
    expect(outputSize({ x: 0, y: 0, width: 4800, height: 3200 })).toEqual({ width: 2400, height: 1600 });
    expect(outputSize({ x: 0, y: 0, width: 800, height: 1200 })).toEqual({ width: 800, height: 1200 });
  });
});
