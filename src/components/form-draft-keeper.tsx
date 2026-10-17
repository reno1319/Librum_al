"use client";

import { useEffect, useState } from "react";
import { applyFormDraft, parseFormDraft, serializeFormDraft } from "@/lib/form-draft";

// Keeps what the author typed in the form with id `formId` when its
// Server Action sends them back with an error (see src/lib/form-draft.ts
// for what is and isn't kept). `restore` is true only when the page was
// rendered with an error. Any other render of the page drops the copy,
// so an old one can't come back later.
//
// Every storage access is wrapped: sessionStorage can be missing or
// throw (private windows, blocked site data), and then the form simply
// behaves as it did before this component existed.
export function FormDraftKeeper({
  formId,
  storageKey,
  fieldNames,
  restore,
  notice,
}: {
  formId: string;
  storageKey: string;
  fieldNames: readonly string[];
  restore: boolean;
  notice: string;
}) {
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const form = document.getElementById(formId);
    if (!(form instanceof HTMLFormElement)) return;

    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(storageKey);
      window.sessionStorage.removeItem(storageKey);
    } catch {
      raw = null;
    }

    if (restore) {
      const values = parseFormDraft(raw, fieldNames, Date.now());
      if (values && applyFormDraft(form, values, fieldNames) > 0) {
        // Restoring into the DOM after the effect runs is the point of
        // this component; the notice tells the author it happened.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRestored(true);
      }
    }

    function handleSubmit() {
      try {
        window.sessionStorage.setItem(
          storageKey,
          serializeFormDraft(form as HTMLFormElement, fieldNames, Date.now()),
        );
      } catch {
        // Nothing kept; the save itself is unaffected.
      }
    }

    form.addEventListener("submit", handleSubmit);
    return () => form.removeEventListener("submit", handleSubmit);
  }, [formId, storageKey, fieldNames, restore]);

  if (!restored) return null;

  return (
    <p role="status" className="mt-2 text-sm text-muted">
      {notice}
    </p>
  );
}
