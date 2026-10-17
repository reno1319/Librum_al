// QA "typed edits are lost": a Server Action that rejects a form
// redirects back to the page with ?error=..., and the page renders its
// fields again from the database, so everything the author typed is
// gone. These helpers keep a short-lived copy of an explicit allow-list
// of plain text/select fields in the tab's sessionStorage at submit
// time, and put it back when the page comes back with an error.
//
// Deliberately narrow:
//   - only the field names the caller lists, and only text-like inputs,
//     textareas and selects -- never hidden, file, password, checkbox or
//     radio inputs, so upload paths and tokens are never copied;
//   - a select only takes a value one of its own options has;
//   - a copy older than FORM_DRAFT_MAX_AGE_MS, or one that does not
//     parse into exactly the expected shape, is ignored;
//   - nothing here decides what is saved: the restored values are only
//     shown in the form, and the server validates them again on the next
//     submit exactly as before.

export const FORM_DRAFT_MAX_AGE_MS = 10 * 60 * 1000;

const RESTORABLE_INPUT_TYPES = new Set(["text", "date", "number", "email", "url", "search", "tel"]);

// The parts of HTMLInputElement / HTMLTextAreaElement / HTMLSelectElement
// these helpers touch, so they can be unit-tested without a DOM.
export type DraftField = {
  tagName: string;
  type?: string;
  value: string;
  options?: ArrayLike<{ value: string }>;
};

export type DraftForm = {
  elements: { namedItem(name: string): unknown };
};

function restorableField(form: DraftForm, name: string): DraftField | null {
  const element = form.elements.namedItem(name) as DraftField | null;
  if (!element || typeof element !== "object" || typeof element.tagName !== "string") {
    // Missing, or a RadioNodeList (several controls share the name).
    return null;
  }
  const tag = element.tagName.toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return element;
  if (tag === "INPUT" && RESTORABLE_INPUT_TYPES.has(String(element.type ?? "text").toLowerCase())) {
    return element;
  }
  return null;
}

export function serializeFormDraft(
  form: DraftForm,
  fieldNames: readonly string[],
  now: number,
): string {
  const values: Record<string, string> = {};
  for (const name of fieldNames) {
    const field = restorableField(form, name);
    if (field && typeof field.value === "string") values[name] = field.value;
  }
  return JSON.stringify({ savedAt: now, values });
}

export function parseFormDraft(
  raw: string | null,
  fieldNames: readonly string[],
  now: number,
): Record<string, string> | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { savedAt, values } = parsed as { savedAt?: unknown; values?: unknown };
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (savedAt > now || now - savedAt > FORM_DRAFT_MAX_AGE_MS) return null;
  if (!values || typeof values !== "object" || Array.isArray(values)) return null;

  const result: Record<string, string> = {};
  for (const name of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    const value = (values as Record<string, unknown>)[name];
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

// Returns how many fields actually changed, so the caller can tell the
// author only when something was put back.
export function applyFormDraft(
  form: DraftForm,
  values: Record<string, string>,
  fieldNames: readonly string[],
): number {
  let changed = 0;
  for (const name of fieldNames) {
    if (!Object.prototype.hasOwnProperty.call(values, name)) continue;
    const value = values[name];
    const field = restorableField(form, name);
    if (!field || field.value === value) continue;
    if (field.tagName.toUpperCase() === "SELECT") {
      const options = Array.from(field.options ?? []);
      if (!options.some((option) => option.value === value)) continue;
    }
    field.value = value;
    changed += 1;
  }
  return changed;
}
