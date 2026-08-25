import type { ReactNode } from "react";

// LIBRUM 2.0 UI-1: replaces the raw `bg-red-50 text-red-700`-style
// slabs the UI-1 audit found repeated 48 times across 25 files -- but
// deliberately not migrating any of those call sites yet (see the
// audit). This component just gives future pages a real primitive to
// migrate to, in UI-2 through UI-9.
//
// Restrained by design: a light neutral surface with a small colored
// left accent border, not a saturated full-color block -- per the
// approved UI-1 correction. No icon prop: requiring one (or building a
// 4-icon set) would add API surface this task's scope doesn't call
// for; a plain text title carries the same meaning without it.

export type AlertVariant = "success" | "error" | "warning" | "info";

const VARIANT_CLASSES: Record<AlertVariant, { border: string; title: string }> = {
  success: { border: "border-emerald-600", title: "text-emerald-800" },
  error: { border: "border-red-600", title: "text-red-800" },
  warning: { border: "border-amber-600", title: "text-amber-800" },
  info: { border: "border-primary", title: "text-primary" },
};

export type AlertProps = {
  variant?: AlertVariant;
  title?: string;
  children?: ReactNode;
  className?: string;
};

export function Alert({ variant = "info", title, children, className }: AlertProps) {
  const { border, title: titleClass } = VARIANT_CLASSES[variant];

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={[
        "rounded-md border-l-4 bg-surface px-4 py-3 text-sm text-foreground/90",
        border,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {title && <p className={["font-medium", titleClass].join(" ")}>{title}</p>}
      {children && <div className={title ? "mt-1" : undefined}>{children}</div>}
    </div>
  );
}
