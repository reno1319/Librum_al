"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

// D1 (Renato 11-04, mockup v5): the one look the book editor's three
// tabs share -- a white box per section with its name on the left and
// the help text and fields on the right (stacked on a phone), compact
// fields like KDP's, and one action bar at the end of every tab.
// Look only: every field keeps its name, value and rule.
//
// Field sizes: 34px tall with 14px text on a computer; 44px with 16px
// text on a phone, because iPhone Safari zooms in on any text box with
// smaller text when it is tapped.

export const EDITOR_CONTROL_CLASSES =
  "focus-ring w-full rounded-md border border-control bg-surface px-2.5 h-11 text-base sm:h-[34px] sm:text-sm disabled:bg-background disabled:text-muted";

/** The same control outlined in the error colour while its message shows. */
export function editorControlClassesFor(invalid: boolean): string {
  return invalid ? EDITOR_CONTROL_CLASSES.replace("border-control", "border-red-700") : EDITOR_CONTROL_CLASSES;
}

/** A field's bold label (above the field). */
export const EDITOR_LABEL_CLASSES = "text-sm font-bold text-foreground";
/** A field and its label, hint and error, stacked. */
export const EDITOR_FIELD_CLASSES = "flex flex-col gap-1";
/** A small line under a field. */
export const EDITOR_HINT_CLASSES = "text-[13px] text-muted";

/** "(opsional)" in grey after a label. */
export function Optional({ children = "opsional" }: { children?: ReactNode }) {
  return <span className="font-normal text-muted"> ({children})</span>;
}

export function EditorSection({
  id,
  title,
  help,
  live,
  children,
}: {
  id: string;
  title: string;
  help?: ReactNode;
  // The section's content changes as the author types (royalty preview).
  live?: boolean;
  children?: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      aria-live={live ? "polite" : undefined}
      className="grid gap-x-7 gap-y-2 rounded-lg bg-surface px-4 pt-[18px] pb-5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:px-8 sm:pt-[22px] sm:pb-[26px]"
    >
      <h2 id={id} className="m-0 font-sans text-[17px] font-semibold leading-snug text-muted">
        {title}
      </h2>
      <div className="flex min-w-0 flex-col gap-3">
        {help && <p className="text-sm text-foreground">{help}</p>}
        {children}
      </div>
    </section>
  );
}

const BAR_BUTTON = "focus-ring inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full px-[18px] text-sm font-medium sm:min-h-9 sm:w-auto sm:min-w-60";
export const EDITOR_SECONDARY_BUTTON = `${BAR_BUTTON} border border-control bg-surface text-foreground hover:bg-surface-hover`;
export const EDITOR_PRIMARY_BUTTON = `${BAR_BUTTON} border border-primary bg-primary text-primary-foreground hover:bg-primary-hover`;
// Something is still missing: a dashed outline, not a faded green that
// looks broken (mockup change 7).
export const EDITOR_BLOCKED_BUTTON = `${BAR_BUTTON} cursor-not-allowed border border-dashed border-control bg-surface text-muted`;
/** A small outlined button inside a section (Hiq, + Krijo seri të re...). */
export const EDITOR_SMALL_BUTTON =
  "focus-ring inline-flex min-h-11 w-fit items-center justify-center rounded-full border border-control bg-surface px-3.5 text-sm font-medium text-foreground hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-8";
/** A text-link-looking button. */
export const EDITOR_LINK_BUTTON =
  "focus-ring w-fit rounded-sm bg-transparent p-0 text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The bar at the end of every tab: an optional "← previous tab" link
 * (bottom left; it is a submit button, so it saves first, then goes
 * back), "Ruaj draftin", and the main button with a line under it.
 * While the form is saving, all of them are off and "Po ruhet…" shows.
 */
export function EditorActionBar({
  backLabel,
  primaryLabel,
  primaryIntent,
  primaryBlocked = false,
  primaryNote,
  extra,
}: {
  // The previous tab's name; no back link on the first tab.
  backLabel?: string;
  primaryLabel: string;
  primaryIntent: string;
  // Something is still missing: the main button cannot be pressed.
  primaryBlocked?: boolean;
  primaryNote?: string;
  extra?: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <div className="mt-3 flex flex-col gap-2">
      {pending && (
        <p role="status" className="text-sm text-muted sm:text-right">
          Po ruhet…
        </p>
      )}
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-[1fr_auto_auto]">
        {backLabel ? (
          <button
            type="submit"
            name="intent"
            value="back"
            disabled={pending}
            className={`${EDITOR_LINK_BUTTON} order-3 justify-self-center sm:order-none sm:justify-self-start sm:self-center`}
          >
            &larr; {backLabel}
          </button>
        ) : (
          <span className="hidden sm:block" />
        )}
        <button type="submit" name="intent" value="save" disabled={pending} className={EDITOR_SECONDARY_BUTTON}>
          Ruaj draftin
        </button>
        <div className="flex flex-col items-center gap-1.5">
          <button
            type="submit"
            name="intent"
            value={primaryIntent}
            disabled={pending || primaryBlocked}
            className={primaryBlocked ? EDITOR_BLOCKED_BUTTON : EDITOR_PRIMARY_BUTTON}
          >
            {primaryLabel}
          </button>
          {primaryNote && <small className="text-center text-[13px] text-muted">{primaryNote}</small>}
        </div>
      </div>
      {extra}
    </div>
  );
}
