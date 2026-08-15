export function StarRating({ rating }: { rating: number }) {
  const rounded = Math.max(0, Math.min(5, Math.round(rating)));

  return (
    <span aria-label={`${rating} out of 5 stars`}>
      <span className="text-primary">{"★".repeat(rounded)}</span>
      <span className="text-border">{"★".repeat(5 - rounded)}</span>
    </span>
  );
}
