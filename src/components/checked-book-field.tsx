"use client";

import { useState } from "react";
import { fieldErrorClasses, formControlClassesFor } from "@/lib/form-styles";
import {
  FUTURE_DATE_MESSAGE,
  INVALID_ISBN_MESSAGE,
  isFutureDateString,
  isValidIsbn,
} from "@/lib/book-identifiers";

// FIX1 (X9): the Edit page's ISBN and "Originally published" inputs,
// checked in the browser with the same rules createBook/updateBook
// apply (src/lib/book-identifiers.ts). Uncontrolled on purpose: the
// page's FormDraftKeeper writes restored values straight into the
// inputs by name, which a controlled value would overwrite.
//
// The message shows beside the field once the author leaves it, and
// setCustomValidity() makes the browser refuse "Save changes" while it
// stands, so the server's own check is a second line, not the first.
// The New Book wizard has its own copy of this wiring in its state.

/**
 * LEFTOVERS (L2): the ISBN field's message. A stored legacy ISBN that
 * the author has not changed is accepted by updateBook as it is (it
 * compares the trimmed submission with the raw stored value), so it
 * must not block "Save changes" here either. Any edited value is
 * checked as before.
 */
export function isbnFieldMessage(value: string, defaultValue: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === defaultValue) return "";
  return isValidIsbn(trimmed) ? "" : INVALID_ISBN_MESSAGE;
}

export function CheckedBookField({
  kind,
  name,
  defaultValue,
  placeholder,
  id,
}: {
  kind: "isbn" | "pastDate";
  name: string;
  defaultValue: string;
  placeholder?: string;
  id: string;
}) {
  const [error, setError] = useState("");

  function check(input: HTMLInputElement, show: boolean) {
    const value = input.value.trim();
    const message =
      kind === "isbn"
        ? isbnFieldMessage(input.value, defaultValue)
        : isFutureDateString(value)
          ? FUTURE_DATE_MESSAGE
          : "";
    input.setCustomValidity(message);
    if (show || !message) setError(message);
  }

  const errorId = `${id}-error`;
  return (
    <>
      <input
        id={id}
        name={name}
        type={kind === "isbn" ? "text" : "date"}
        defaultValue={defaultValue}
        placeholder={placeholder}
        onInput={(e) => check(e.currentTarget, false)}
        onBlur={(e) => check(e.currentTarget, true)}
        onInvalid={(e) => check(e.currentTarget, true)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={formControlClassesFor(!!error)}
      />
      {error && (
        <span id={errorId} className={fieldErrorClasses}>
          {error}
        </span>
      )}
    </>
  );
}
