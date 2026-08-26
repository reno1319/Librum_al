import type { ButtonHTMLAttributes, ReactNode } from "react";

// LIBRUM 2.0 UI-1: the first of five shared primitives this phase
// introduces (see the UI-1 audit/design report). A thin wrapper around
// an ordinary <button> -- every native prop (type, disabled, name,
// value, formAction, onClick, ...) passes straight through via
// ...rest, so this works exactly like a plain <button> everywhere a
// Server Action already attaches one via `action`/`formAction`. No
// "use client" needed: nothing here reads state or attaches an event
// handler of its own.
//
// Deliberately not migrating any of the 31 existing hand-written
// primary-button call sites identified in the UI-1 audit -- this
// establishes the primitive; call-site migration happens page by page
// in UI-2 through UI-9.

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "text";
export type ButtonSize = "sm" | "md" | "lg";

// "text" is a link-shaped button (no padding/background of its own),
// so it deliberately never receives the padding/sizing classes below --
// its own VARIANT_CLASSES entry supplies everything it needs.
const BASE_CLASSES =
  "focus-ring inline-flex items-center justify-center gap-2 rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary-hover",
  secondary: "bg-surface-hover text-foreground hover:bg-border",
  outline: "border border-border bg-transparent text-foreground hover:bg-surface-hover",
  ghost: "bg-transparent text-foreground hover:bg-surface-hover",
  danger: "bg-red-700 text-white hover:bg-red-800",
  text: "h-auto bg-transparent p-0 text-primary underline-offset-2 hover:underline",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "px-3 py-1.5 text-sm",
  md: "px-4 py-2 text-sm",
  lg: "px-6 py-3 text-base",
};

// LIBRUM 2.0 UI-2: exported so a non-<button> element that needs to
// look exactly like a Button -- a <Link> styled as a CTA, which is a
// navigation, not a button semantically -- can share the same variant/
// size classes without duplicating the literal string at each call
// site. Button itself uses this internally too, so there is exactly
// one place either kind of caller's classes come from.
export function buttonClasses(
  variant: ButtonVariant = "primary",
  size: ButtonSize = "md",
  className?: string,
): string {
  return [BASE_CLASSES, VARIANT_CLASSES[variant], variant === "text" ? null : SIZE_CLASSES[size], className]
    .filter(Boolean)
    .join(" ");
}

// A tiny inline spinner rather than a dependency -- this is the only
// place in the primitive that needs one, and it's a handful of SVG
// attributes, not worth an icon library for.
function ButtonSpinner() {
  return (
    <svg aria-hidden="true" className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  // Presentational only -- the caller owns whatever state decides when
  // this is true (e.g. a Client Component wrapping useFormStatus()).
  // Button itself holds no state, so this stays a plain prop rather
  // than pulling in speculative client-side loading architecture.
  loading?: boolean;
};

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = buttonClasses(variant, size, className);

  return (
    <button className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <ButtonSpinner />}
      {children as ReactNode}
    </button>
  );
}
