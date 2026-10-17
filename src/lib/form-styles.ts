// LIBRUM 2.0 UI-7: shared class strings for the Publishing Studio's
// plain form controls -- the same "extract a small helper" pattern
// buttonClasses() already establishes for buttons in this codebase,
// applied here to the severe duplication the UI-7 audit found (the
// literal string "rounded-lg border border-border bg-surface px-3
// py-2" repeated well over a dozen times across the new-book wizard
// and the edit page). Deliberately plain constants, not a wrapping
// component -- inputs/selects/textareas/file inputs each need
// different surrounding markup, so a shared class string solves the
// actual duplication without adding an abstraction layer none of them
// uniformly need.
// V1: the mockup's control border (border-control, #8c8472) and 3px
// corner (rounded-control); the placeholder colour is global, in
// globals.css.
export const formControlClasses =
  "focus-ring rounded-control border border-control bg-surface px-3 py-2 text-sm";

// FIX1 (X8): the same control outlined in the error colour while its
// own message shows beside it. A swap, not an extra class, so the two
// border colours never compete in the stylesheet.
export function formControlClassesFor(invalid: boolean): string {
  return invalid
    ? formControlClasses.replace("border-control", "border-red-700")
    : formControlClasses;
}

// FIX1 (X8): the one style for a message that belongs to one field.
export const fieldErrorClasses = "text-sm font-medium text-red-800";

export const fileInputClasses = "focus-ring rounded-sm text-sm";

// V1: a plain file field's own "Choose file" button, which the browser
// otherwise draws in its own grey, gets the control border and corner.
// Add a book's cover and manuscript pickers draw their button as a
// green outline button instead (their PICKER_INPUT_CLASSES).
export const plainFileInputClasses = `${fileInputClasses} file:mr-3 file:cursor-pointer file:rounded-control file:border file:border-solid file:border-control file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-foreground hover:file:bg-surface-hover`;
