import type { ReactNode } from "react";

// LIBRUM 2.0 UI-1: the shared page-title block for both public and
// dashboard pages (see the UI-1 audit's public/dashboard relationship
// section) -- same typography/tokens either way, individual pages
// still control their own surrounding layout and container width.
//
// eyebrow: justified by an existing convention already in the
// codebase (BookCard's uppercase/tracking-wide/muted genre label,
// src/components/book-card.tsx) -- not a new visual idea introduced
// here, just reused for page titles.
// actions: a simple slot, not a layout system -- callers that need
// something more elaborate than "title + optional action(s) on the
// same row" should compose their own header rather than stretching
// this prop.

export type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  className?: string;
};

export function PageHeader({ eyebrow, title, description, actions, className }: PageHeaderProps) {
  return (
    <div
      className={["flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className]
        .filter(Boolean)
        .join(" ")}
    >
      <div>
        {eyebrow && (
          <p className="text-xs font-medium uppercase tracking-wide text-muted">{eyebrow}</p>
        )}
        <h1 className="font-serif text-2xl font-semibold text-foreground md:text-4xl">
          {title}
        </h1>
        {description && <p className="mt-2 text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
    </div>
  );
}
