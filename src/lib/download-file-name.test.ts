import { describe, expect, it } from "vitest";
import { downloadFileName } from "./download-file-name";

describe("downloadFileName", () => {
  it.each([
    ["Ëndrra e çmendur", "endrra-e-cmendur.epub"],
    ["KËNGA E FUNDIT", "kenga-e-fundit.epub"],
    ["The Great God Pan", "the-great-god-pan.epub"],
    ["  Libri #1: Fillimi!  ", "libri-1-fillimi.epub"],
    ["Café à Tirana", "cafe-a-tirana.epub"],
  ])("%s -> %s", (title, expected) => {
    expect(downloadFileName(title)).toBe(expected);
  });

  it("never returns a bare .epub", () => {
    expect(downloadFileName("")).toBe("liber.epub");
    expect(downloadFileName("—")).toBe("liber.epub");
    expect(downloadFileName("Ωμέγα")).toBe("liber.epub");
  });

  it("only ever contains safe header characters", () => {
    for (const title of ['a"b', "a\\b", "a\r\nb", "çë/ÇË", "x;y=z"]) {
      expect(downloadFileName(title)).toMatch(/^[a-z0-9-]+\.epub$/);
    }
  });
});
