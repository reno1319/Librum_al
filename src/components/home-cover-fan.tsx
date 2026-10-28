import Link from "next/link";
import { fanDrawOrder, type FanCover } from "@/lib/home-picks-logic";

// HOME-PICKS-1 (Renato 2026-10-25, board "Home: cover fan, admin picks"):
// three real front covers fanned on the green hero, the middle one (slot
// 1) larger and in front, the two side covers smaller and behind it.
// Same three covers on phone and desktop, scaled down on small screens.
// Each cover is one link to its book. A
// paid slot shows a small "Sponsored" tag on its cover (Law 50/2025:
// paid placement must be marked); the link's accessible name says it
// too. Covers are plain <img> like every other cover on the site (the
// project has no next/image remote host configured): fixed CSS widths,
// the middle one fetched first.

type FanBook = { id: string; title: string; author: string | null; url: string };

export const SPONSORED_LABEL = "Sponsorizuar";

// Literal class strings so Tailwind generates them. Widths are shares
// of the column, so the fan shrinks with the screen. On desktop (lg)
// the covers fill the whole column, about 23% larger (Renato
// 2026-10-25, option b), in the same middle-to-side proportion.
const COVER_WIDTH = {
  side: "w-[30%] max-w-[170px] lg:w-[33%] lg:max-w-[190px]",
  middle: "w-[38%] max-w-[220px] lg:w-[42%] lg:max-w-[240px]",
} as const;

export function HomeCoverFan({ covers }: { covers: FanCover<FanBook>[] }) {
  const ordered = fanDrawOrder(covers);
  return (
    <div className="mx-auto w-full min-w-0 max-w-[520px] lg:mx-0 lg:max-w-none">
      <ul className="flex items-center justify-center py-4 sm:py-6" aria-label="Libra të zgjedhur">
        {ordered.map((cover) => {
          const middle = cover.slot === 1;
          return (
            <li
              key={cover.book.id}
              className={`relative ${middle ? `z-10 -mx-[4%] ${COVER_WIDTH.middle}` : `z-0 ${COVER_WIDTH.side}`}`}
            >
              <Link
                href={`/books/${cover.book.id}`}
                aria-label={`Shikoni ${cover.book.title} në Librum${cover.sponsored ? ` (${SPONSORED_LABEL.toLowerCase()})` : ""}`}
                className="focus-ring group/cover relative block rounded-[3px]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={cover.book.url}
                  alt=""
                  width={middle ? 220 : 170}
                  height={middle ? 330 : 255}
                  loading="eager"
                  fetchPriority={middle ? "high" : "auto"}
                  className={`block aspect-[2/3] w-full rounded-[3px] object-cover transition-transform duration-150 group-hover/cover:-translate-y-1 motion-reduce:transition-none motion-reduce:group-hover/cover:translate-y-0 ${
                    middle
                      ? "shadow-[0_18px_36px_-10px_rgba(0,0,0,0.6)]"
                      : "shadow-[0_10px_24px_-10px_rgba(0,0,0,0.55)] brightness-[0.92]"
                  }`}
                />
                {cover.sponsored && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 left-1.5 rounded-[2px] bg-[#f7f3ea]/95 px-1.5 py-0.5 text-[0.625rem] font-semibold tracking-[0.06em] text-[#1e3a32] uppercase shadow-sm sm:top-2 sm:left-2 sm:text-[0.6875rem]"
                  >
                    {SPONSORED_LABEL}
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
