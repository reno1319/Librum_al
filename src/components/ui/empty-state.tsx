import type { ReactNode } from "react";

// LIBRUM 2.0 UI-1: a neutral, reusable "nothing here yet" block for
// empty lists/not-found-shaped states -- deliberately no illustration
// system, per the approved UI-1 scope. `action` is typically a Button
// or a Link styled as one; left as plain ReactNode rather than a
// narrower type so either works without this component knowing which.

export type EmptyStateProps = {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={[
        "flex flex-col items-center gap-2 rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <p className="font-serif text-lg font-semibold text-foreground">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
