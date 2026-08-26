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
export const formControlClasses =
  "focus-ring rounded-lg border border-border bg-surface px-3 py-2 text-sm";

export const fileInputClasses = "focus-ring rounded-sm text-sm";
