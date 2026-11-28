export function StarRating({ rating }: { rating: number }) {
  const rounded = Math.max(0, Math.min(5, Math.round(rating)));

  return (
    // FIX1 (X4): role="img" so the label is announced; one decimal, the
    // same figure the text beside it shows.
    <span role="img" aria-label={`${String(Number(rating.toFixed(1))).replace(".", ",")} nga 5 yje`}>
      {/* LC2 (Renato 11-25): gold, the same colours as the Libraria cards' Stars. */}
      <span className="text-[#d99a00]">{"★".repeat(rounded)}</span>
      <span className="text-[#d8d0be]">{"★".repeat(5 - rounded)}</span>
    </span>
  );
}
