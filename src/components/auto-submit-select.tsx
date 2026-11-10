"use client";

import type { ReactNode } from "react";

// P2 (Libraria sort): a native <select> that sends its own form as soon
// as the reader picks an option. Without JavaScript nothing happens on
// change, so the form also carries a <noscript> submit button.
export function AutoSubmitSelect({
  id,
  name,
  defaultValue,
  className,
  children,
}: {
  id: string;
  name: string;
  defaultValue: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <select
      id={id}
      name={name}
      defaultValue={defaultValue}
      className={className}
      onChange={(event) => event.currentTarget.form?.requestSubmit()}
    >
      {children}
    </select>
  );
}
