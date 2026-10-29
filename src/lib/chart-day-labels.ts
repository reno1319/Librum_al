// FIX1 (X13): the Sales chart's day labels. Each bar keeps its day
// number; the first bar, and any bar where the month changes, also
// carries the month's short name, so "12" reads as "12 Oct". Month
// names are a fixed list, never the server's locale.
// SQ-16: chart dates are Tirana calendar days stored at UTC midnight
// (revenue-logic.ts tiranaDayStart), so they are read with getUTC*.
// ALBANIAN-11: Albanian short month names.
// SQ-16: lowercase, like every other Albanian date (glossary R4).
const MONTHS = ["jan", "shk", "mar", "pri", "maj", "qer", "kor", "gus", "sht", "tet", "nën", "dhj"];

export type ChartDayLabel = { day: string; month: string | null };

export function chartDayLabels(dates: Date[]): ChartDayLabel[] {
  return dates.map((date, i) => {
    const previous = i > 0 ? dates[i - 1] : null;
    const monthChanged = !previous || previous.getUTCMonth() !== date.getUTCMonth();
    return { day: String(date.getUTCDate()), month: monthChanged ? MONTHS[date.getUTCMonth()] : null };
  });
}

// SQ-16: the bar's hover text ("28 tet"), from the same fields as the
// labels so the two can never name different days. It used to go
// through toLocaleDateString in the server's time zone, which need not
// match the Tirana days the bars now use.
export function chartDayTitle(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
}
