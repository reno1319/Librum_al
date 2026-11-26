import { describe, expect, it } from "vitest";
import {
  isOwnStagedSlidePicturePath,
  isSlidePicturePath,
  parseSlideForm,
  slideDaysLabel,
  slideStatus,
  stagedSlidePicturePath,
  tiranaToday,
} from "./libraria-banner";

// LR1 patch 3: the banner slide rules.
const BOOK = "11111111-1111-4111-8111-111111111111";
const SLIDE = "22222222-2222-4222-8222-222222222222";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ bookId: BOOK, description: "Një libër i ri.", ...fields })) fd.set(k, v);
  return fd;
}

describe("tiranaToday", () => {
  it("uses Tirana's day, not UTC's", () => {
    expect(tiranaToday(new Date("2026-11-25T22:30:00Z"))).toBe("2026-11-25");
    expect(tiranaToday(new Date("2026-11-25T23:30:00Z"))).toBe("2026-11-26");
    // Summer time: UTC+2.
    expect(tiranaToday(new Date("2026-07-01T22:30:00Z"))).toBe("2026-07-02");
  });
});

describe("slideStatus", () => {
  const today = "2026-11-25";
  it("every day and a live book: showing", () => {
    expect(slideStatus({ starts_on: null, ends_on: null }, true, today)).toBe("showing");
  });
  it("first and last day both count as showing", () => {
    expect(slideStatus({ starts_on: today, ends_on: today }, true, today)).toBe("showing");
  });
  it("before the first day: waiting; after the last day: ended", () => {
    expect(slideStatus({ starts_on: "2026-11-26", ends_on: null }, true, today)).toBe("waiting");
    expect(slideStatus({ starts_on: null, ends_on: "2026-11-24" }, true, today)).toBe("ended");
  });
  it("a book that is not live: book_not_live, unless the slide has already ended", () => {
    expect(slideStatus({ starts_on: null, ends_on: null }, false, today)).toBe("book_not_live");
    expect(slideStatus({ starts_on: "2026-12-01", ends_on: null }, false, today)).toBe("book_not_live");
    expect(slideStatus({ starts_on: null, ends_on: "2026-11-01" }, false, today)).toBe("ended");
  });
});

describe("parseSlideForm", () => {
  it("a new slide with only the required parts", () => {
    expect(parseSlideForm(form({}))).toEqual({
      ok: true,
      slideId: null,
      bookId: BOOK,
      description: "Një libër i ri.",
      tag: null,
      startsOn: null,
      endsOn: null,
      removePhonePicture: false,
    });
  });

  it("an edit with everything, trimmed", () => {
    expect(
      parseSlideForm(
        form({
          slideId: SLIDE,
          description: "  Ofertë.  ",
          tag: "  E re ",
          startsOn: "2026-11-20",
          endsOn: "2026-12-10",
          removePhonePicture: "on",
        }),
      ),
    ).toEqual({
      ok: true,
      slideId: SLIDE,
      bookId: BOOK,
      description: "Ofertë.",
      tag: "E re",
      startsOn: "2026-11-20",
      endsOn: "2026-12-10",
      removePhonePicture: true,
    });
  });

  it.each([
    [{ slideId: "nope" }, "slide"],
    [{ bookId: "" }, "book"],
    [{ bookId: "x" }, "book"],
    [{ description: "   " }, "description_empty"],
    [{ description: "one\ntwo" }, "description_lines"],
    [{ description: "a".repeat(121) }, "description_long"],
    [{ tag: "a\rb" }, "tag_lines"],
    [{ tag: "a".repeat(25) }, "tag_long"],
    [{ startsOn: "2026-02-30" }, "days"],
    [{ endsOn: "25/11/2026" }, "days"],
    [{ startsOn: "2026-12-10", endsOn: "2026-12-09" }, "days_order"],
  ])("%o is refused as %s", (fields, reason) => {
    expect(parseSlideForm(form(fields as Record<string, string>))).toEqual({ ok: false, reason });
  });

  it("the limits count letters, not bytes: 120 and 24 ë's are allowed", () => {
    expect(parseSlideForm(form({ description: "ë".repeat(120), tag: "ë".repeat(24) })).ok).toBe(true);
  });

  it("the same first and last day is allowed", () => {
    expect(parseSlideForm(form({ startsOn: "2026-12-01", endsOn: "2026-12-01" })).ok).toBe(true);
  });
});

describe("isSlidePicturePath", () => {
  it("only slides/<uuid>.jpg", () => {
    expect(isSlidePicturePath(`slides/${SLIDE}.jpg`)).toBe(true);
    expect(isSlidePicturePath(`slides/${SLIDE}.png`)).toBe(false);
    expect(isSlidePicturePath(`covers/${SLIDE}.jpg`)).toBe(false);
    expect(isSlidePicturePath(`slides/../${SLIDE}.jpg`)).toBe(false);
  });
});

describe("slideDaysLabel", () => {
  it("names the days", () => {
    expect(slideDaysLabel({ starts_on: null, ends_on: null })).toBe("Every day");
    expect(slideDaysLabel({ starts_on: "2026-11-20", ends_on: "2026-12-10" })).toBe("2026-11-20 to 2026-12-10");
    expect(slideDaysLabel({ starts_on: "2026-11-20", ends_on: null })).toBe("From 2026-11-20");
    expect(slideDaysLabel({ starts_on: null, ends_on: "2026-12-10" })).toBe("Until 2026-12-10");
  });
});

describe("staged slide pictures (two-pictures fix)", () => {
  const ME = "55555555-5555-4555-8555-555555555555";
  const FILE = "66666666-6666-4666-8666-666666666666";

  it("builds the waiting-file name under the staff member's own folder", () => {
    expect(stagedSlidePicturePath(ME, FILE, "png")).toBe(`${ME}/tmp/libraria/${FILE}.png`);
    expect(isOwnStagedSlidePicturePath(stagedSlidePicturePath(ME, FILE, "jpg"), ME)).toBe(true);
  });

  it.each([
    `77777777-7777-4777-8777-777777777777/tmp/libraria/${FILE}.jpg`,
    `${ME}/tmp/blog/${FILE}.jpg`,
    `${ME}/tmp/libraria/${FILE}.webp`,
    `${ME}/tmp/libraria/${FILE}.jpg/x`,
    `${ME}/tmp/libraria/../${FILE}.jpg`,
    `${ME}/tmp/libraria/AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA.jpg`,
    `/${ME}/tmp/libraria/${FILE}.jpg`,
    `${ME}/tmp/libraria/${FILE}.jpg `,
    "",
    42,
    null,
  ])("refuses %s", (path) => {
    expect(isOwnStagedSlidePicturePath(path, ME)).toBe(false);
  });

  it("refuses when the caller's id is not an id", () => {
    expect(isOwnStagedSlidePicturePath(`x/tmp/libraria/${FILE}.jpg`, "x")).toBe(false);
  });
});
