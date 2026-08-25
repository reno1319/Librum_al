import type { ReactNode } from "react";

// LIBRUM 2.0 UI-1: a general-purpose, non-interactive surface -- forms,
// legal-copy sections, admin detail panels. Deliberately no hover
// behavior by default (a plain SurfaceCard isn't clickable and
// shouldn't visually suggest it is); an interactive variant is a later
// UI-phase decision once a real interactive-card use case exists, per
// the UI-1 audit's own BookCard/SurfaceCard/StatCard/ActionCard
// distinction.

export type SurfaceCardProps = {
  children: ReactNode;
  className?: string;
};

export function SurfaceCard({ children, className }: SurfaceCardProps) {
  return (
    <div
      className={["rounded-lg border border-border bg-surface p-6", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}
