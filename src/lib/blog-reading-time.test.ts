import { describe, expect, it } from "vitest";
import { calculateReadingTime } from "./blog-reading-time";

describe("calculateReadingTime", () => {
  it("returns 1 for empty content", () => {
    expect(calculateReadingTime("")).toBe(1);
  });

  it("returns 1 for a short article well under 200 words", () => {
    const words = Array(50).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(1);
  });

  it("calculates a longer article proportionally (400 words -> 2 minutes)", () => {
    const words = Array(400).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(2);
  });

  it("calculates a much longer article proportionally (1000 words -> 5 minutes)", () => {
    const words = Array(1000).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(5);
  });

  it("rounds to the nearest minute rather than always flooring", () => {
    // 300 words / 200 wpm = 1.5 -> rounds to 2
    const words = Array(300).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(2);
  });

  it("never returns less than 1 minute for non-empty content", () => {
    expect(calculateReadingTime("a")).toBe(1);
    expect(calculateReadingTime("   ")).toBe(1);
  });

  it("Markdown syntax characters do not badly distort the word count", () => {
    // Headings, bold/italic markers, and list bullets are counted as
    // part of adjacent words by a whitespace split, not as extra words
    // of their own -- the overcount stays small and proportionate,
    // never doubling or wildly inflating the estimate.
    const plain = Array(200).fill("word").join(" ");
    const withMarkdownSyntax =
      "# Heading\n\n" +
      Array(200).fill("**word**").join(" ") +
      "\n\n- list item one\n- list item two";
    const plainMinutes = calculateReadingTime(plain);
    const markdownMinutes = calculateReadingTime(withMarkdownSyntax);
    expect(markdownMinutes).toBeGreaterThanOrEqual(plainMinutes);
    expect(markdownMinutes).toBeLessThanOrEqual(plainMinutes + 1);
  });

  it("handles multiple consecutive whitespace/newlines correctly", () => {
    const words = Array(200).fill("word").join("\n\n   \n");
    expect(calculateReadingTime(words)).toBe(1);
  });
});
