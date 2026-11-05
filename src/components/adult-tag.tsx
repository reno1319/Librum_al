import { ADULT_TAG } from "@/lib/book-reader-details";

// BD15 P8 (Q1 a): the small "18+" tag on book and bundle cards. A label
// only (plan Q5): nothing is hidden or blurred. The screen-reader text
// says what the two characters mean.
export function AdultTag() {
  return (
    <span className="inline-block rounded-[3px] border border-[#8a2418] px-1 text-[0.6875rem] leading-4 font-bold text-[#8a2418]">
      <span aria-hidden="true">{ADULT_TAG}</span>
      <span className="sr-only">Për të rritur, 18+</span>
    </span>
  );
}
