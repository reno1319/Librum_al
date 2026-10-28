export function StarRating({ rating }: { rating: number }) {
  const rounded = Math.max(0, Math.min(5, Math.round(rating)));

  return (
    // FIX1 (X4): role="img" so the label is announced; one decimal, the
    // same figure the text beside it shows.
    <span role="img" aria-label={`${Number(rating.toFixed(1))} nga 5 yje`}>
      <span className="text-primary">{"★".repeat(rounded)}</span>
      <span className="text-border">{"★".repeat(5 - rounded)}</span>
    </span>
  );
}
