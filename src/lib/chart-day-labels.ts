// FIX1 (X13): the Sales chart's day labels. Each bar keeps its day
// number; the first bar, and any bar where the month changes, also
// carries the month's short name, so "12" reads as "12 Oct". Month
// names are a fixed English list (the site's language until the
// Albanian pass), never the server's locale. Reads the same local-time
// fields revenue-logic.ts builds the chart dates with.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ChartDayLabel = { day: string; month: string | null };

export function chartDayLabels(dates: Date[]): ChartDayLabel[] {
  return dates.map((date, i) => {
    const previous = i > 0 ? dates[i - 1] : null;
    const monthChanged = !previous || previous.getMonth() !== date.getMonth();
    return { day: String(date.getDate()), month: monthChanged ? MONTHS[date.getMonth()] : null };
  });
}
