// G4 batch 3: the count bubble on a menu row (approved pictures r1).
// Gold #806510 with a white number; on the sidebar's current (dark
// green) row it inverts. Screen readers hear "3 waiting".
export function AdminNavBubble({ count, inverted = false }: { count: number | undefined; inverted?: boolean }) {
  if (!count || count <= 0) return null;
  return (
    <span
      className={`ml-2 inline-flex min-w-6 items-center justify-center rounded-full px-1.5 text-[0.75rem] leading-5 font-bold ${
        inverted ? "bg-primary-foreground text-primary" : "bg-[#806510] text-white"
      }`}
    >
      {count}
      <span className="sr-only"> waiting</span>
    </span>
  );
}
