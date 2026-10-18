import { describe, expect, it } from "vitest";
import { INVALID_ISBN_MESSAGE, isValidIsbn } from "@/lib/book-identifiers";
import { isbnFieldMessage } from "./checked-book-field";

// LEFTOVERS (L2): the Edit page's ISBN message. An unchanged stored
// legacy ISBN (one updateBook keeps as it is) never blocks "Save
// changes"; any edited value is checked as before.
const LEGACY = "12345";
const OTHER_INVALID = "99999";
const VALID = "978-3-16-148410-0";

describe("isbnFieldMessage", () => {
  it("the fixtures are what they claim", () => {
    expect(isValidIsbn(LEGACY)).toBe(false);
    expect(isValidIsbn(OTHER_INVALID)).toBe(false);
    expect(isValidIsbn(VALID)).toBe(true);
  });

  it("an unchanged invalid stored ISBN -> no message", () => {
    expect(isbnFieldMessage(LEGACY, LEGACY)).toBe("");
  });

  it("the unchanged value with spaces around it -> no message (the server trims)", () => {
    expect(isbnFieldMessage(`  ${LEGACY} `, LEGACY)).toBe("");
  });

  it("edited to another invalid value -> the existing message", () => {
    expect(isbnFieldMessage(OTHER_INVALID, LEGACY)).toBe(INVALID_ISBN_MESSAGE);
    expect(isbnFieldMessage(`${LEGACY}0`, LEGACY)).toBe(INVALID_ISBN_MESSAGE);
  });

  it("edited, then put back to the stored value -> no message again", () => {
    expect(isbnFieldMessage(OTHER_INVALID, LEGACY)).toBe(INVALID_ISBN_MESSAGE);
    expect(isbnFieldMessage(LEGACY, LEGACY)).toBe("");
  });

  it("empty -> no message", () => {
    expect(isbnFieldMessage("", LEGACY)).toBe("");
    expect(isbnFieldMessage("   ", "")).toBe("");
  });

  it("no stored ISBN: an invalid value -> the message, a valid one -> none", () => {
    expect(isbnFieldMessage(OTHER_INVALID, "")).toBe(INVALID_ISBN_MESSAGE);
    expect(isbnFieldMessage(VALID, "")).toBe("");
  });

  it("a stored value with spaces of its own is compared raw, as the server does", () => {
    expect(isbnFieldMessage(LEGACY, ` ${LEGACY}`)).toBe(INVALID_ISBN_MESSAGE);
  });
});
